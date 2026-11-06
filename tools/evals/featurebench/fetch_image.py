#!/usr/bin/env python3
"""从镜像站并发拉取 FeatureBench 镜像并组装 OCI layout（随后用 skopeo load 进 Docker）。

用法: fetch_image2.py --image libercoders/xxx --digest sha256:... --out /tmp/fbwork/oci-xxx [--workers 16]
校验: manifest digest 必须等于 --digest；每个 blob sha256 必须匹配 manifest。
"""
import argparse, hashlib, json, os, threading, time, urllib.request, urllib.error

UA = 'curl/8.7.1'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--image', required=True)
    ap.add_argument('--digest', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--mirror', default='https://docker.jiaxin.site')
    ap.add_argument('--workers', type=int, default=16)
    ap.add_argument('--chunk-mb', type=int, default=8)
    args = ap.parse_args()

    repo = args.image
    os.makedirs(f'{args.out}/blobs/sha256', exist_ok=True)
    logf = f'{args.out}.log'
    lock = threading.Lock()
    tok = {'v': None, 'at': 0}
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def log(msg):
        line = time.strftime('%H:%M:%S ') + msg
        print(line, flush=True)
        with open(logf, 'a') as f:
            f.write(line + '\n')

    def token(force=False):
        with lock:
            if not force and tok['v'] and time.time() - tok['at'] < 180:
                return tok['v']
            url = f'{args.mirror}/token?service=registry.docker.io&scope=repository:{repo}:pull'
            for i in range(6):
                try:
                    d = json.load(opener.open(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=30))
                    t = d.get('token') or d.get('access_token')
                    if t:
                        tok['v'] = t; tok['at'] = time.time(); return t
                except Exception:
                    time.sleep(1 + i)
            raise RuntimeError('token failed')

    def get(url, extra=None, timeout=180):
        h = {'Authorization': 'Bearer ' + token(), 'User-Agent': UA}
        if extra: h.update(extra)
        return opener.open(urllib.request.Request(url, headers=h), timeout=timeout)

    # manifest
    murl = f'{args.mirror}/v2/{repo}/manifests/latest'
    for i in range(6):
        try:
            body = get(murl, {'Accept': 'application/vnd.docker.distribution.manifest.v2+json'}).read()
            got = 'sha256:' + hashlib.sha256(body).hexdigest()
            if got != args.digest:
                raise RuntimeError(f'manifest digest mismatch {got} != {args.digest}')
            open(f'{args.out}/blobs/sha256/{got[7:]}', 'wb').write(body)
            manifest = json.loads(body)
            break
        except urllib.error.HTTPError as e:
            if e.code == 401: token(force=True)
            time.sleep(1 + i)
        except Exception:
            time.sleep(1 + i)
    else:
        raise RuntimeError('manifest fetch failed')
    log(f'manifest ok layers={len(manifest["layers"])} config={manifest["config"]["digest"][:20]}')

    def download(digest, size):
        hexd = digest.split(':', 1)[1]
        path = f'{args.out}/blobs/sha256/{hexd}'
        if os.path.exists(path) and os.path.getsize(path) == size:
            with open(path, 'rb') as f:
                if hashlib.sha256(f.read()).hexdigest() == hexd:
                    log(f'blob {hexd[:12]} cached'); return
        url = f'{args.mirror}/v2/{repo}/blobs/{digest}'
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_TRUNC, 0o644)
        os.ftruncate(fd, size)
        chunk = args.chunk_mb * 1024 * 1024
        ranges = [(s, min(s + chunk, size) - 1) for s in range(0, size, chunk)]
        idx = [0]; done_b = [0]; done = [0]; rr = threading.Lock(); errs = []
        t0 = time.time()
        def worker():
            while True:
                with rr:
                    if idx[0] >= len(ranges): return
                    i = idx[0]; idx[0] += 1
                s, e = ranges[i]; want = e - s + 1
                for attempt in range(8):
                    try:
                        resp = get(url, {'Range': f'bytes={s}-{e}'})
                        data = resp.read()
                        if getattr(resp, 'status', None) not in (206, 200) or len(data) != want:
                            raise RuntimeError(f'range {s}-{e} bad')
                        os.pwrite(fd, data, s)
                        with rr:
                            done[0] += 1; done_b[0] += want
                        break
                    except urllib.error.HTTPError as e:
                        if e.code == 401: token(force=True)
                        time.sleep(1 + attempt)
                    except Exception:
                        time.sleep(1 + attempt)
                else:
                    errs.append((s, e))
        threads = [threading.Thread(target=worker, daemon=True) for _ in range(args.workers)]
        for t in threads: t.start()
        last = [0, t0, 0]
        while any(t.is_alive() for t in threads):
            time.sleep(10)
            with rr:
                db, dd = done_b[0], done[0]
            now = time.time()
            speed = (db - last[0]) / (now - last[1]) / 1024 / 1024
            if dd != last[2]:
                log(f'blob {hexd[:12]} {dd}/{len(ranges)} chunks {db/1024/1024:.0f}/{size/1024/1024:.0f}MB {speed:.2f}MB/s')
                last = [db, now, dd]
        for t in threads: t.join()
        os.close(fd)
        if errs:
            raise RuntimeError(f'blob incomplete {len(errs)}')
        with open(path, 'rb') as f:
            if hashlib.sha256(f.read()).hexdigest() != hexd:
                raise RuntimeError('blob digest mismatch')
        log(f'blob {hexd[:12]} OK ({size/1024/1024:.0f}MB) in {time.time()-t0:.0f}s')

    download(manifest['config']['digest'], manifest['config']['size'])
    for n, layer in enumerate(sorted(manifest['layers'], key=lambda x: -x['size'])):
        log(f'layer {n+1}/{len(manifest["layers"])} {layer["digest"][:20]} {layer["size"]/1024/1024:.0f}MB')
        download(layer['digest'], layer['size'])
    idx = {'schemaVersion': 2, 'manifests': [{
        'mediaType': manifest.get('mediaType', 'application/vnd.docker.distribution.manifest.v2+json'),
        'digest': args.digest,
        'size': os.path.getsize(f'{args.out}/blobs/sha256/{args.digest[7:]}'),
        'annotations': {'org.opencontainers.image.ref.name': 'latest'},
    }]}
    open(f'{args.out}/index.json', 'w').write(json.dumps(idx))
    open(f'{args.out}/oci-layout', 'w').write(json.dumps({'imageLayoutVersion': '1.0.0'}))
    log('OCI layout complete')


if __name__ == '__main__':
    main()
