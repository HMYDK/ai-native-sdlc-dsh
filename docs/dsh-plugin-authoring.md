# How to author and distribute a DSH plugin

Evidence base: the extracted Desktop runtime at `<extracted-dsh-runtime>/`
(`package.json` → `"name": "@deepseek-ai/dsh-desktop-runtime"`, `"version": "0.2.0-rc.2"`),
all official packages under `<extracted-dsh-runtime>/node_modules/@deepseek-ai/`.
Vendored framework version: `@deepseek-ai/cordis@4.0.4`, `@deepseek-ai/cordis-plugin-loader@1.0.5`,
`@deepseek-ai/cordis-plugin-include@1.0.9`, `@deepseek-ai/schemastery@3.18.4`.

Shorthand used below: `PKG` = `<extracted-dsh-runtime>/node_modules/@deepseek-ai`.

> **Not present in this extract (flagged up front).** Every README cross-reference of the form
> `../../../docs/cookbook/adding-a-package.md`, `../../../.agents/notes/...`,
> `../../../apps/cli/reference/README.md`, `../../../docs/config-catalog.md` is *monorepo-relative*.
> The extract ships only `node_modules` + `package.json` + `desktop-runtime.json`; I verified the
> Electron `app.asar` contains the same three entries under `dsh/`. So the authoring cookbook,
> agent notes, CLI reference, root `tsconfig.host.json`/`tsconfig.client.json`, the shared
> **tsdown Client preset**, and the `create-cordis` scaffolder (listed in
> `PKG/cordis/README.md:81` but not installed) are **not available**. Claims about them below are
> marked as reported-but-unverified.

---

## 1. The exact shape of a DSH plugin

### 1.1 The framework contract (authoritative source)

`PKG/cordis/src/registry.ts:92-146` defines the whole surface:

```ts
/** Supported plugin entrypoint shapes. */
export type Plugin<T = any> =
  | Plugin.Function<T>
  | Plugin.Constructor<T>
  | Plugin.Object<T>

export namespace Plugin {
  /** Shared metadata understood by the plugin registry and related tooling. */
  export interface Base<T = any> {
    /** Display name used for fiber diagnostics and logger names. */
    name?: string
    /** Standard-schema validator applied to config before the plugin starts. */
    Config?: StandardSchemaV1<any, T>
    /** Services the plugin requires; it only loads while all are available. */
    inject?: Inject
    /** Service name(s) the plugin provides (read by `Service` and by loaders). */
    provide?: string | string[]
    /** Service names whose intercept config the plugin declares it consumes. */
    intercept?: Dict<boolean>
  }
  export interface Function<T = any> extends Base<T> { (ctx: Context, config: T): any }
  export interface Constructor<T = any> extends Base<T> { new (ctx: Context, config: T): any }
  export interface Object<T = any> extends Base<T> { apply(ctx: Context, config: T): any }
}
```

Runtime normalization (`PKG/cordis/src/registry.ts:222-228, 316-336`):

```ts
  resolve(plugin: Plugin): Function | undefined {
    // plugin.apply may throw
    try {
      if (typeof plugin === 'function') return plugin
      if (isApplicable(plugin)) return plugin.apply
    } catch {}
  }
  ...
  plugin(plugin: Plugin, config?: any, getOuterStack = buildOuterStack()) {
    const callback = this.resolve(plugin)
    if (!callback) throw new Error('invalid plugin, expect function or object with an "apply" method, received ' + typeof plugin)
    ...
    runtime = { name, callback, fibers: new DisposableList(), Config: plugin.Config }
```

`Config` is validated through the **Standard Schema v1** protocol, not a DSH-specific schema object
(`PKG/cordis/src/fiber.ts:50-62`):

```ts
export function resolveConfig(runtime: Plugin.Runtime, config: any) {
  if (!runtime.Config) return config
  const result = runtime.Config['~standard'].validate(config)
  if ('then' in result) throw new TypeError('Async config validation is not supported')
  if (result.issues) throw new ValidationError(result.issues)
  else return result.value
}
```

Answers to the sub-questions:

* **Is it a TypeScript ESM module exporting `apply(ctx, config)`?** The *published artifact* is an
  **ESM JS module** (`"type": "module"` in every package). TypeScript is a monorepo authoring
  choice, not a runtime requirement: `PKG/cordis-plugin-loader/src/config/tree.ts:111-129` imports
  the module with plain `await import(...)` (or through DSH's resolver). `apply(ctx, config)` is one
  of three accepted shapes; a bare function (`export default function (ctx, config) {}`) and a
  **class** are equally valid.
* **`export const name`** — yes, optional. Read as `plugin.name` (`registry.ts:324-326`), except the
  literal name `'apply'` is discarded (`if (name === 'apply') name = undefined`).
* **`export const inject`** — yes, optional; `Inject<M> = (keyof M)[] | { [K in keyof M]?: M[K] }`
  (`registry.ts:19`). The array form requests services; the object form also supplies per-service
  *intercept config* for the plugin's own context (`fiber.ts:238-245`).
* **`export const Config`** — yes, optional; must be a **Standard Schema** (`~standard.validate`).
  Both `@deepseek-ai/schemastery` and `zod` qualify. Counted in the extract: **138** package.json
  files reference `@deepseek-ai/schemastery`, **54** reference `zod`. DSH plugins use
  schemastery for `Config` (`import z from "@deepseek-ai/schemastery"`) and zod for tool
  parameter/output schemas.
* **JSON Schema?** No — `Config` is not JSON Schema. It is the *source* from which JSON Schema is
  generated: `generateConfigSchema(...)` "returns `ConfigSchemaDump`" and projects "shared
  definitions projected from plugin Config graphs" (`PKG/dsh-app-boot/README.md:77-79`), i.e. the
  direction is Config → JSON Schema, never the reverse.

### 1.2 What the Loader does with a package

A `cordis.yml` / `cordis.patch.yml` row is an `EntryOptions`
(`PKG/cordis-plugin-loader/src/config/entry.ts:9-23`):

```ts
export interface EntryOptions {
  /** Stable id inside the containing entry tree. */
  id: string
  /** Module specifier imported by the entry tree. */
  name: string
  /** Config passed to the plugin. */
  config?: any
  /** Marks this entry as a nested group. */
  group?: boolean | null
  /** Prevents this entry and descendants from running. */
  disabled?: boolean | null
  /** Required services or service intercept config for this entry. */
  inject?: Inject | null
}
```

and `entry.ts:221-235`:

```ts
  private async _init() {
    let exports: any
    try {
      exports = await this.parent.tree.import(this.options.name, this.getOuterStack)
    } catch (error) { this.ctx.logger.error(error); return }
    finally { this._initTask = undefined }
    const plugin = this.loader.unwrapExports(exports)
    this._patchContext([])
    this.loader.showLog(this, 'apply')
    this.fiber = this.ctx.registry.plugin(plugin, this.options.config, this.getOuterStack).ctx.fiber
  }
```

with `PKG/cordis-plugin-loader/src/index.ts:200-208`:

```ts
  /** Normalize ESM/CJS/default export shapes before applying a plugin. */
  unwrapExports(exports: any) {
    if (isNullable(exports)) return exports
    exports = exports.default ?? exports
    if (!exports.__esModule) return exports
    return exports.default ?? exports
  }
```

**This is the key mechanic:** a package with **no default export** gives the Loader the *whole ESM
namespace object*, which then satisfies `Plugin.Object` via its named `apply` — and its named `name`,
`inject`, `Config`. That is exactly why DSH plugins are written as top-level named exports. A package
with a `default` export gets the default instead.

### 1.3 Minimal real examples

**(a) Smallest complete plugin, fully readable (unbundled).**
`PKG/dsh-tool-subagent-control/lib/types/index.js` — published at the `./list-agents`-adjacent source
path, the entire plugin:

```js
import { defineTool } from '@deepseek-ai/dsh-tools';
export const name = 'tool-subagent-control';
export const inject = ['tools', 'subagents'];
export function apply(ctx) {
    ctx.tools.register(defineTool({ name: 'send_message', /* ... */ }));
    ctx.tools.register(defineTool({ name: 'interrupt_agent', /* ... */ }));
}
```

Its manifest (`PKG/dsh-tool-subagent-control/package.json`) has `"type": "module"`,
`"main": "lib/index.js"`, and a `peerDependencies` block naming `@deepseek-ai/cordis: "~4.0.4"` plus
`@deepseek-ai/dsh-*: "0.2.0-rc.2"` — no `dsh` key at all.

**(b) Smallest complete plugin with config.**
`PKG/dsh-repeat-tool-reminder/lib/index.js:1446-1456` and `:1532-1536`, `:1597`:

```js
const name = "repeat-tool-reminder";
const Config = z.object({
	thresholds: z.array(z.number()).default([3, 5, 8]),
	include: z.array(z.string()).default([]),
	exclude: z.array(z.string()).default([]),
	argumentsPreviewChars: z.number().default(500)
});
...
function apply(ctx, config) {
	const thresholds = validateThresholds(config.thresholds);
	...
	ctx.on("tools/post-execute", async (exec, _result, next) => { ... });
	ctx.on("agent/pre-step", ({ agent, messages }, next) => { ... });
}
//#endregion
export { Config, apply, name };
```

with `import z from "@deepseek-ai/schemastery";` at line 2.

**(c) `dsh-tool-todo`** (`PKG/dsh-tool-todo/lib/index.js:11-20, 196`):

```js
const name = "tool-todo";
const inject = ["tools", "sessionProjections"];
...
const Config = z.object({ allowParallelInProgress: z.boolean().required() });
...
export { Config, apply, inject, name };
```

The module JSDoc states the convention: *"Named exports preserve loader injection metadata."*
Note it imports **both** `z` (schemastery, for `Config`) and `{ z as z$1 }` (zod, for the tool
parameters).

**(d) A class plugin (no `apply` at all).** `dsh-permission-presets` exports neither `apply` nor
`name`; it default-exports a Service subclass (`PKG/dsh-permission-presets/lib/index.js:138, 170,
408`):

```js
static Config = z.object({ ... });
...
super(ctx, "permissionPresets");
...
export { AUTO_PRESET, CUSTOM_PRESET, PermissionPresetService, PermissionPresetService as default };
```

The Loader's `unwrapExports` picks the default, `isConstructor()` is true, and
`PKG/cordis/src/fiber.ts:251-257` runs `new runtime.callback(this.ctx, this.config)`. `super(ctx, name)`
is the `provide` registration (`PKG/cordis/src/service.ts:43-59`).

**(e) The canonical config shape the runtime expects** is plain YAML:
```yaml
- id: tool-plugin-manager
  name: '@deepseek-ai/dsh-plugin-manager/tools'
  disabled: true
```
(from `PKG/dsh-base/cordis.patch.yml:20-22`), with `!!js` expressions allowed
(`disabled: !!js "!ctx.get('profileContext')"`, same file line 25).

### 1.4 What is *not* required

There is no DSH-specific plugin base class, no `dsh.plugin` manifest key, and no required file layout.
The only hard requirements for a *host* plugin are: (1) the module resolves from the profile, and
(2) it yields a valid `Plugin` shape after `unwrapExports`. Everything else — `name`, `Config`,
`inject`, `dsh.bundle`, `dsh.client` — is optional. If the package declares
`peerDependencies` on `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*`, those ranges become a hard gate
(§5.3).

---

## 2. "Bundle" vs "plugin"

### 2.1 Definitions

* **Plugin** = one importable module that exports a Cordis plugin shape. It is referenced by one
  Loader entry (`id` + `name` + optional `config`).
* **Bundle** = an **npm package that ships a Cordis patch layer** — a list of entry rows and id-targeted
  overrides — declared in `package.json`:

`PKG/dsh-package-manifest/README.md:46`:
> "`DshBundleManifest.patch` is one patch file path or an ordered list of them, each relative to the
> package root; the launcher applies a list in order as one bundle layer."

`PKG/dsh-base/package.json` (end of file):
```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```
`PKG/dsh-web-app/package.json` (ordered list form):
```json
"dsh": { "bundle": { "patch": ["./cordis.patch.yml","./presets/standard.patch.yml",
                              "./presets/ptc.patch.yml","./presets/minimal.patch.yml",
                              "./presets/cordis.patch.yml"] } }
```

**A bundle is a pure configuration carrier** — `dsh-base`'s own `lib/index.js` is not a plugin entry
at all; it exists solely so the package has a resolvable `main`. A bundle *contains* plugins by naming
them in its patch rows. The relation is many-to-many: `dsh-base` inserts ~120 rows, each of which is a
separate plugin package that is a plain `dependencies` entry of the bundle.

### 2.2 Profile directories and `dsh.profile.bundles`

`PKG/dsh/README.md:37`:
> "A profile directory holds a `package.json` (out-of-tree plugin dependencies plus the profile
> manifest `dsh.profile` with its ordered `bundles` list) and a `cordis.patch.yml` (the user's own
> patch layer)."

Profile location: `$DSH_HOME/profiles/<name>`; `$DSH_HOME` = explicit config → `$DSH_HOME` env →
`~/.dsh` (`PKG/dsh-home-paths/README.md:39`). Created by `initProfile`
(`PKG/dsh-app-boot/lib/index.js:576-592`), which writes exactly:

```js
const manifest = {
  name: `dsh-profile-${basename(dir)}`,
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: [...bundles] } }
};
...
const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`;
```

So the profile root `package.json` is:
```json
{ "name": "dsh-profile-web", "private": true, "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } } }
```

Shipped templates (`PKG/dsh-app-boot/lib/index.js:529-543`):
```js
const PROFILE_TEMPLATES = {
	acp: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-acp-app"] },
	web: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] },
	headless: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] },
	sdk: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-sdk-app"] },
	"sdk-minimal": { bundles: ["@deepseek-ai/dsh-sdk-minimal"] }
};
const DEFAULT_PROFILE_BUNDLES = ["@deepseek-ai/dsh-base"];
```

Layer order — `PKG/dsh/README.md:41-46`:
> "The tree composes over an empty root: each bundle's patch in `dsh.profile.bundles` order; then the
> profile's `cordis.patch.yml`, then the home-level `$DSH_HOME/cordis.patch.yml`; then `--patch`
> overlays. Bundles named in `dsh.profile.bundles` resolve from the dsh installation first
> (`@deepseek-ai/dsh-base`, …), then from the profile's own `node_modules`, where pnpm installs
> out-of-tree plugins."

Confirmed in code at `PKG/dsh-app-boot/lib/index.js:901-907`:
```js
function resolveBundleDir(binName, packageName, installAnchor, profileDir) {
	for (const anchor of [installAnchor, join(profileDir, "package.json")]) { ... }
```

### 2.3 `cordis.patch.yml` semantics

Parsed as `entryListSchema = yaml.JSON_SCHEMA.extend(JsExpr)` (`PKG/dsh-app-boot/lib/index.js:33`),
applied by `applyEntryPatches` (`PKG/dsh-app-boot/lib/index.js:61-110`). Supported patch forms:

| Patch | Effect |
|---|---|
| `- insert: [row, row, …]` | append rows to the root entry list |
| `- id: <groupId>` + `insert: […]` | append rows into that group's `config` array |
| `- id: <rowId>` + `disabled:` / `config:` / other keys | override matching row's fields (whole-`config` replace, **not** deep merge) |
| `- id: <rowId>` + `name: '<pkg>'` | same, but assert the module name matches first |

Quoting the code:
```js
const { id, insert, name, ...overrides } = patch;
if (insert) {
  if (id) { const target = entryMap.get(id); ... target.config.push(...insert) }
  else data.push(...insert);
  ...
}
if (!id) { warn("patch: id is required for non-insert patches"); continue }
const target = entryMap.get(id);
if (!target) { warn("patch: entry %C not found", id); continue }
if (name && name !== target.name) { warn("patch: name mismatch for %C ..."); continue }
```
Inserted rows are indexed immediately, so a later patch in the same list can target a row an earlier
patch inserted. A patch that matches nothing warns and is skipped.

Inserted row names may be **absolute filesystem paths, file URLs, or package specifiers**
(`PKG/dsh-app-boot/README.md:65`).

### 2.4 How an out-of-tree third-party plugin is installed and enabled

Two distinct routes, because **only bundles are auto-enabled**:

**(A) The package IS a bundle** (`dsh.bundle.patch` present):
1. `dsh plugin --profile <name> add <spec>` (`PKG/dsh/README.md:18` — "`dsh plugin --profile <name>
   <pnpm args>` | Manage a profile's plugins by forwarding to pnpm in the profile directory") — or the
   Web **Plugins** page / `plugin_manager` tool `install_bundle`.
2. pnpm runs in the profile dir and installs into `<profile>/node_modules`.
3. `reconcile()` (`PKG/dsh-plugin-manager/lib/types/operations.js:44-72`) appends the new dependency to
   `dsh.profile.bundles`:
```js
for (const name of dependencies) {
    if (beforeDeps.has(name)) continue;
    const metadata = bundleManifest(name, dir, anchor);
    if (metadata?.dsh?.bundle === undefined) {
        options.onOutput?.(`dsh: warning: ${name} declares no dsh.bundle — installed as a plain dependency, not a profile layer\n`, 'stderr');
        continue;
    }
    for (const file of bundlePatchPaths(resolveBundleDir('dsh', name, anchor, dir), metadata.dsh.bundle))
        loadOverlayPatches('dsh', file);
    if (!bundles.includes(name)) bundles.push(name);
}
```
4. Composition happens on the next recomposition: live profiles with HMR apply it in-process; others
   need a restart (`PKG/dsh-plugin-manager/README.md:14, 67`).

**(B) The package is a plain plugin** (no `dsh.bundle`):
1. `dsh plugin add <spec>` installs it as an ordinary dependency — with the warning above.
2. You must hand-add a row in `<profile>/cordis.patch.yml`:
```yaml
- insert:
    - id: my-plugin
      name: 'my-npm-package'      # or '/abs/path/to/plugin/lib/index.js'
      config: { ... }
```
This is the "inserted plugin names may be absolute filesystem paths, file URLs, or package
specifiers" case (`PKG/dsh-app-boot/README.md:65`), and it is the route the Plugin Manager UI exposes
as per-row toggles — `set_plugin` only writes `disabled` into the last matching override in the
profile patch (`PKG/dsh-plugin-manager/lib/types/patch.js`).

**Recommendation:** ship third-party contributions as a **bundle**. Otherwise the colleague must hand-edit
YAML, cannot use the Plugins page's bundle card, and gets no auto-enable.

### 2.5 Required `package.json` metadata — exact list

| Field | Required? | Enforced? | Source |
|---|---|---|---|
| `name`, `version` | yes (npm) | yes, needed for identity on a compat mismatch | `PKG/dsh-app-boot/lib/index.js:261-264, 303-305` |
| `type: "module"` | practically yes | ESM import | every official package |
| `main` / `exports["."]` | yes | resolver | `PKG/dsh-client-modules/lib/index.js:82-88` |
| `dsh.bundle.patch` | only for bundles | yes — absent ⇒ "installed as a plain dependency, not a profile layer" | `operations.js:59` |
| `dsh.client` | only for a browser half | yes — malformed ⇒ activation error | `PKG/dsh-client-modules/lib/index.js:61-75` |
| `dsh.manifestVersion` | no | **not enforced** | `PKG/dsh-package-manifest/README.md:93` |
| `engines.dsh` | no | **not enforced** ("These checks use peer declarations, not `engines.dsh`") | `PKG/dsh-app-boot/README.md:52` |
| `peerDependencies["@deepseek-ai/dsh*"]` | no, but if present | **yes — hard gate** | `PKG/dsh-app-boot/lib/index.js:286-313` |
| `peerDependencies["@deepseek-ai/cordis"]` | no | yes, same gate | same |
| `icon` (relative SVG/PNG/JPEG/WebP ≤ 256 KiB) | no | display only | `PKG/dsh-app-boot/lib/index.js:1860-1872` |
| `exports["./package.json"]`, `exports["./locale/*.json"]` | needed for metadata | display only | `PKG/dsh-app-boot/lib/index.js:1969-1990` |

Declared-but-unenforced example (`PKG/dsh-package-manifest/README.md:93`):
> "**Compatibility is declarative.** Current installers and loaders do not enforce
> `dsh.manifestVersion` or `engines.dsh`; declaring a range does not reject incompatible hosts or
> validate SemVer syntax."

**Peer range convention observed in practice:** every official plugin peers on
`"@deepseek-ai/cordis": "~4.0.4"` and on each `@deepseek-ai/dsh-*` package it imports, pinned to the
exact released version (e.g. `"@deepseek-ai/dsh-tools": "0.2.0-rc.2"`). `workspace:^`, `workspace:~`,
`workspace:*` are treated as "the current runtime" (`PKG/dsh-app-boot/lib/index.js:295-299`).

**Display metadata format** (`PKG/dsh-app-boot/lib/index.js:1925-1954, 1969-1984`):
`./locale/en.json` (+ optional `zh.json`, filename = language id) each holding
```json
{ "meta": { "title": "Voice input", "description": "Transcribe recordings locally with SenseVoice; ..." } }
```
and `package.json.icon` as a **relative** path. Confirmed against
`PKG/dsh-experimental-voice-input-bundle/locale/en.json` and its `"icon": "./icon.svg"`. Missing text
falls back to `package.json` `name`/`description`.

---

## 3. Client-side plugins (Web GUI contributions)

### 3.1 Declaration

`PKG/dsh-client-modules/README.md:34`:
> "A browser plugin package declares `dsh.client` in its `package.json` with `platform: 'web'`, exports
> a `./client` bundle, and lists any non-baseline module requests under `dsh.client.external`. The host
> half turns each declaration into a served bundle under `/plugins`, ordered so dynamic providers load
> before their consumers."

The field set is fixed by the parser (`PKG/dsh-client-modules/lib/index.js:61-75`):

```js
function parseDshClient(pkgName, value) {
	if (value === void 0) return void 0;
	if (typeof value !== "object" || value === null) throw new Error(`client-modules: ${pkgName} has a non-object dsh.client declaration`);
	const decl = value;
	if (typeof decl.platform !== "string") throw new Error(`client-modules: ${pkgName} dsh.client.platform must be a string`);
	const inject = optionalStringArray(pkgName, "dsh.client.inject", decl.inject);
	const external = optionalStringArray(pkgName, "dsh.client.external", decl.external);
	if (decl.immediately !== void 0 && typeof decl.immediately !== "boolean") throw new Error(`client-modules: ${pkgName} dsh.client.immediately must be a boolean`);
	return { platform: decl.platform, ...inject..., ...external..., ...immediately... };
}
```

- `platform` (required string; only `"web"` is served — `lib/index.js:714`),
- `inject` (string[]; **package module dependencies** — edges in the module graph, used by
  `orderByModuleGraph` and `prune`, not Cordis service names),
- `external` (string[]; extra non-baseline module requests),
- `immediately` (boolean; initial-load scheduling).

Real example, `PKG/dsh-client-ui-jobs/package.json`:
```json
"dsh": { "client": { "inject": ["@deepseek-ai/dsh-api-job-controller",
  "@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-conversation",
  "@deepseek-ai/dsh-client-ui-primitives"], "platform": "web" } },
"exports": { "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" } }
```

The `./client` export is **mandatory** — `clientExportOf` (`lib/index.js:171-181`) accepts a string or
`{default: string}`, and `resolveMeta` throws otherwise
(`lib/index.js:719`): `` `client-modules: ${packageName} declares dsh.client but exports no "./client" bundle` ``.

### 3.2 The host half still needs a Loader entry

A pure UI package's Node half is a no-op stub whose only purpose is to exist as a Loader row so the
scanner can find it. Verbatim, `PKG/dsh-client-ui-goal/lib/index.js` (the *entire* file):

```js
/**
* Goal surface plugin, node half. Pure UI plugin: the empty apply exists so
* the plugin appears in the host cordis.yml / Loader; the browser half
* ships via exports["./client"], discovered through the package.json
* dsh.client declaration.
*/
/** Host plugin body — no host-side behavior for this surface plugin. */
function apply() {}
export { apply };
```

and it is enabled by an ordinary row (`PKG/dsh-web-app/cordis.patch.yml:375-376`):
```yaml
    - id: ui-goal
      name: '@deepseek-ai/dsh-client-ui-goal'
```
Enumerate the shipped roster: `grep -n "client-ui" PKG/dsh-web-app/cordis.patch.yml` — ~50 rows.
69 packages in the extract carry a `dsh.client` declaration.

### 3.3 Which Slot?

Slots are **not** a fixed enum; they are a declaration-merged, parent-owned registry
(`PKG/dsh-client-ui-slots/README.md`):
> "Declaring a slot is claiming it: the registering entry becomes the only entry allowed to render
> that key, and registering into an undeclared slot, declaring an already-declared child, mounting one
> shared handle under two scopes, or registering a chain without `select` throws at load."

Slots have four kinds — `single`, `list`, `keyed`, `chain` — and there are two alternative extension
points: **Component Factories** (`ctx.slots.registerFactory()` + `renderFactorySlot()`) and
**store seats**. The consumer registers with `ctx.slots.register(spec, Component)` inside
`ctx.slots.inject(slotName, () => ...)` (the second call binds to the parent's declaration epoch).

Real registration, `PKG/dsh-client-ui-goal/lib/client.js:517-539`:

```js
/** Required services for the Goal dock, command-input projection, Remote mutations, and copy. */
const inject = [ "slots", "sessions", "remote", "remote.goals", "locale", "uiConversation" ];
function apply(ctx) {
	ctx.uiConversation.events.register(goalCommandInputDefinition);
	ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-goal: dictionaries");
	ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
		name: "conversation.chat.node", key: "command-input", locale: NS
	}, GoalCommandInputView));
	...
	ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
		name: "conversation.input.dock", id: "goal", order: 10, locale: NS, inject: (sessionId) => ({...})
	}, GoalDock));
}
```
(exported as `exports.apply = apply; exports.inject = inject;` — lines 609-610.)

Slot names actually used in the shipped build (extracted from `slots.inject("…")` across all
`lib/client.js`, 62 distinct keys), grouped:

* conversation — `conversation.view`, `conversation.composer`, `.composer.dock`, `.chat.node`,
  `.chat.turnTail`, `.input.dock`, `.input.overlay`, `.input.activity`, `.input.attachments`,
  `.input.model`, `.input.permission`, `.input.plan`, `.hero.workspace`, `.hero.workspace.directoryFlow`,
  `.message.images`, `.approval.detail`, `.session.header.actions`, `.session.header.corner`,
  `.session.header.lineage`, `.session.header.utilities`, `.trajectory.images`
* sidebar / shell — `main`, `sidebar`, `sidebar.workspaces`, `sidebar.panellist`, `sidebar.settings`,
  `sidebar.brand.mark`, `sidebar.brand.name`, `sidebar.footer.action`, `sidebar.session.row.hover`,
  `sidebar.session.row.leading`, `sidebar.right.pane.tab`, `sidebar.right.pane.tab.title`,
  `sidebar.right.tab.document`, `.document.action`, `.document.actions`, `.document.office.pdf`,
  `.document.unpreviewable`, `sidebar.right.tab.files.actions`, `sidebar.right.tab.guide.entry`,
  `sidebar.toggle.badge`, `rightbar`, `shell.leading`, `shell.overlay`
* settings — `settings.section`, `settings.header`, `settings.action`, `settings.close`,
  `settings.trigger`, `settings.launcher`, `settings.onboarding`, `settings.general.item`,
  `settings.plugins.tab`
* plugin manager pages — `plugins.item`, `plugins.bundle.config` (keyed by bundle package name),
  `plugins.bundle.activation`, `plugins.row.config` (keyed by `<package name>#<row id>`)
* deliverables — `deliverables.file.actions`, `deliverables.review.file.actions`

The config-page contract is documented at `PKG/dsh-client-ui-plugin-manager/README.md`
(§"Configuration pages"): `view: 'page'` for forms with their own save controls, `view: 'summary'`
under official plugin card titles.

### 3.4 How the bundle is built and served

**Built:** as `lib/client.js` (plus optional compiler-split `client.<name>.js` chunks). The build tool
is the monorepo's shared **tsdown Client preset** — *not shipped in this extract*, so I cannot quote it.
What the runtime requires (`PKG/dsh-client-modules/README.md:50`):
> "The host serves built client bundles, so `pnpm run build` must have produced each `lib/client.js`
> before launch; a missing bundle fails activation loudly with one build instruction and a package/path
> list. Source launch maps host imports to TypeScript source but still consumes the built client export."

The error text is `const CLIENT_BUNDLE_BUILD_INSTRUCTION = "run \`pnpm run build\` before launch"`
(`PKG/dsh-client-modules/lib/index.js:128`), reported with `package:` / `path:` lines per missing
bundle (`:146-152`). For live development, `pnpm run dev:web` runs host + rebuild watchers, and
"*The preset stamps `lib/client.js` after all package-local chunks are written, so a chunk-only
rebuild also advances the package revision without Host-side chunk scanning*"
(`PKG/dsh-client-hmr/README.md:32`).

**Served:** the Node half scans `internal/plugin` emissions, resolves each row's `package.json`
(`resolveMeta`, `lib/index.js:701-731`) and publishes bundles over the HTTP route
`const PLUGIN_ROUTE = "/plugins"` (`lib/index.js:201`), grouped into combo URLs
`/plugins/??<ids>&rev=<rev>`, plus per-package chunks
`/plugins/<id>/client.<name>.js?rev=<rev>`. Revisions are content-free hashes of
`mtimeMs`/`ctimeMs`/`size`. The route follows the `webServer` lifetime; a shell-owned carrier can serve
the identical responses through `fetchBundle()` instead. The boot graph is injected into `<head>` as
`window.__DSH_BOOT__` (`lib/index.js:494`) with `<` escaped.

**Module model:** lazy-CJS. Executing a bundle only registers a factory; module bodies (including CSS
injection) run at first materialization. The shell seeds a frozen baseline table (`PLATFORM_MODULES`:
React, Cordis, and static UI libraries); `dsh.client.external` may only add *exact* non-baseline
requests, each answered by a graph row or an exact static-table key. Self-requests, missing suppliers
and synchronous cycles are rejected at composition. Two important consequences:
`<id>/client` and the bare id resolve to the same exports; and **type-only imports are erased and
create no request**.

---

## 4. Isolation and failure semantics

### 4.1 Same process — yes, always

Nothing in the host-plugin path spawns a process or a Worker. The profile Loader does
`await import(name)` in the current Node process (`PKG/cordis-plugin-loader/src/config/tree.ts:111-129`),
`app-boot`'s `boot()` constructs one `Context` in the current process
(`PKG/dsh-app-boot/lib/index.js:4052-4053`), and `Plugin Manager` states it outright
(`PKG/dsh-plugin-manager/README.md:31`):
> "Profile changes persist across sessions, and installed Host code executes in-process outside the
> workspace sandbox."

Bundle patches themselves are **data**, not code — but note `!!js` expressions in patch files are
evaluated (`PKG/dsh-app-boot/lib/index.js:33`, `yaml.JSON_SCHEMA.extend(JsExpr)`), so a patch file is
also executable.

### 4.2 Sandboxing / permission model — none for plugin code

Three independent statements, all pointing the same way:

1. `PKG/dsh-app-boot/README.md:52` — the only pre-import check DSH performs is a **version** check, and:
   > "These checks use peer declarations, not `engines.dsh`, and are not a sandbox against malicious
   > package code."
2. `PKG/dsh-plugin-manager/README.md:31` — "installed Host code executes in-process **outside the
   workspace sandbox**."
3. `PKG/dsh-plugin-manager/lib/types/tools.js:33` — the *install* action, not the plugin, is gated:
   `requestedMode: 'danger-full-access', effectiveMode: policy.mode, subject: 'plugin management operation'`.

The session permission mode (`danger-full-access` / `workspace-write`) constrains **the agent's tool
calls** through `ctx.shell` / `ctx.fs` policy backends. It does not constrain module-level code in a
plugin: a plugin can `import 'node:child_process'`, `node:fs`, `node:net` and run with the host
user's full authority the moment its module is imported. Confirming the scope of the adjacent fences:
`PKG/dsh-fs-sandbox/README.md:64` — "*The fence is a policy check in trusted code over a
model-controlled path — not a kernel boundary. … Kernel-grade isolation of untrusted code stays
`ctx.shell`'s job*"; `PKG/dsh-fs-local/README.md:131` — "*`config.cwd` is not a sandbox — it is a
resolution default, not containment*."

**The one real sandbox** is `dsh-cordis-host-runner`'s `node:vm` realm, and it applies only to
*runtime-defined* dynamic packages (`define`/`run`/`stop`, the `ctx.cordis` / `ctx.dynamicCordisRunner`
surface) — never to installed bundle/plugin code. Even there
(`PKG/dsh-cordis-host-runner/README.md:60-62`):
> "**Trust stance.** The sandbox isolates globals but is not a security boundary: Node globals are
> absent or redirect to Cordis services (`ctx.fs`, `ctx.web`, `ctx.bash`, the timer helpers), and a
> host half receives a façade without framework internals, yet the services it declares reach the live
> runtime. Treat a dynamic package like bash access."
Its `vmTimeoutMs` default 5000 ms "bounds only synchronous evaluation — an async host-half body
escapes it" (`:139`).

**Operational conclusion: installing a plugin is equivalent to granting arbitrary code execution as
the host user, persisting across sessions.** The only human gate is the Plugin-Manager approval /
`danger-full-access` requirement on the *install* action, plus pnpm's separate dependency
build-script approval (`PKG/dsh-plugin-manager/README.md:58`):
> "Approval persists by package name in this profile, **permits commands with the host user's
> permissions**, and survives another installation failure."

### 4.3 What happens if a plugin throws — the authoritative table

`PKG/dsh-app-boot/README.md:94-107`, verbatim:

| Failure pattern | Optional entry at startup | Required entry at startup | Later configuration HMR |
|---|---|---|---|
| Root config or required overlay is missing, unreadable, malformed, or contains invalid entries | Stop startup | Stop startup | Malformed or invalid live patches are rejected without changing the running configuration; a valid edit applies |
| Module import fails or module evaluation throws | Warn; continue | Stop startup | Report the error; keep successful siblings; a corrected import can activate |
| Plugin config schema validation fails | Warn; continue | Stop startup | A new entry stays inactive; an existing entry retains its prior instance and config; a valid correction applies |
| Config `!!js` evaluation throws | Warn; continue | Stop startup | Report the error; keep successful siblings; a valid correction can activate |
| `disabled: !!js` evaluation throws | Warn; continue | Stop startup | Report the evaluation error rather than treating the entry as disabled; a valid correction can activate |
| Synchronous `apply()` throws | Warn; continue | Stop startup | Report the error; keep successful siblings; corrected config can activate |
| Asynchronous `apply()` throws | Warn after settlement; continue | Stop startup after settlement | Report the error after settlement; keep successful siblings; corrected config can activate |
| An injected service is unavailable | Warn; continue while the entry waits for its dependencies | Stop startup | Keep the entry waiting; adding the missing provider can activate it |
| HTTP port binding fails | Warn; continue without that endpoint | Stop startup | Keep the process running without the failed endpoint; corrected config can restore it |
| Detached asynchronous work outside the `apply()` return Promise produces an unhandled rejection | **Fatal: dispose the app and exit nonzero** | Fatal | Fatal, regardless of entry id |
| A synchronous callback (a stream `'data'` listener, a timer) throws an uncaught exception at any point in the process lifetime | **Fatal: dispose the app and exit nonzero; the failed operation is not resumed** | Fatal | Fatal, regardless of entry id |
| Entry is absent or explicitly disabled | Ignore it | Ignore it | Do not activate it; no required-startup audit |

"Required" is a **hard-coded id allow-list**, not a per-plugin flag
(`PKG/dsh-app-boot/lib/index.js:3836-3844`):

```js
const requiredStartupEntryIds = new Set([
	"agent-loop", "webserver", "modules", "connection",
	"headless-runner", "acp", "sdk-jsonrpc-server"
]);
```
(`modules` and `connection` are the Web bootstrap/transport pair.) Every other entry — including every
third-party plugin — is **optional**: it warns and the app keeps running. A third-party plugin could in
principle claim one of those ids and become load-fatal, but that is an id collision, not a supported
mechanism. `auditStartupEntries` (`lib/index.js:4009-4020`) implements the policy; a required failure
throws `StartupError`, disposes the whole app, and exits 1 (`PKG/dsh-app-boot/README.md:92`).

### 4.4 Throwing *during a hook* (as opposed to during `apply`)

The failure of a listener depends on the Cordis dispatch mode of the event
(`PKG/cordis/src/events.ts:185-192, 196-199, 222-241`):

```ts
  async parallel(...args: any[]) {
    const results = await Promise.allSettled(this.dispatch('emit', args).map(async cb => cb(...args)))
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (errors.length) throw new AggregateError(errors.map(error => error.reason))
  }
  emit(...args: any[]) { this.dispatch('emit', args).map(cb => cb(...args)) }
  ...
  async serial(...args: any[]) {
    for (const cb of this.dispatch('serial', args)) {
      const result = await cb(...args)
      if (isBailed(result)) return result
    }
  }
```

* `emit` — a synchronous throw propagates into the **emitter** (the agent loop / session code). An
  uncaught exception at that point is **fatal** per the table's last rows.
* `parallel` — all listeners run; any rejection is rethrown as an `AggregateError`.
* `serial` / `bail` / `waterfall` — the first throw propagates immediately; a `waterfall` listener that
  simply never calls `next()` **vetoes** the rest of the chain including built-in behavior
  (`events.ts:222-231`).
* An async rejection inside a listener that nobody awaits becomes an unhandled rejection, which
  `installFailLoud` turns into a labelled stderr diagnostic + exit 1
  (`PKG/dsh-app-boot/README.md:43`, `:105`).

The framework *does* protect teardown notification: `emitPluginDisposed`
(`PKG/cordis/src/fiber.ts:119-137`) wraps each `internal/plugin` observer in try/catch and logs.

### 4.5 Failure isolation at the *bundle / row* level

* **Bundle load failure is non-fatal to the profile.** `loadProfileDirectory`
  (`PKG/dsh-app-boot/lib/index.js:920-951`) wraps each bundle in try/catch and records
  `{packageName, reason}` into `skippedBundles`; missing `dsh.bundle` and incompatible peers are both
  skip reasons. Order of the remaining bundles is preserved.
* **Compatibility denial detaches rows rather than importing them.** `preflight`
  (`lib/index.js:2063-2140`) sets `row.disabled = true` on a denied ordinary row ("so a denied plugin
  never imports its module"), keeps a native group mounted with its denied children unloaded, and omits
  an Include whose file reaches a denied plugin.
* **The composition boundary is the limit.** `PKG/dsh-app-boot/README.md:54`: "*These boundaries do not
  cover plugins another embedder mounts through its own `ctx.plugin` call.*"
* **Live (HMR) reloads never roll back.** "Later configuration HMR does not repeat the required-startup
  audit and does not roll back the whole update" (`:92`); "A failed or cancelled installation can leave
  downloaded files under `node_modules` or the pnpm store" (`PKG/dsh-plugin-manager/README.md:133`).

---

## 5. Distribution

### 5.1 Is there a plugin market / registry?

**No DSH-specific marketplace exists.** I searched every README in the extract for
`marketplace` / `plugin market` / `plugin store` / `curated` — the only hits are unrelated
(`dsh-util-code-language`, `libreoffice-kit`, `dsh-client-ui-schedule`, `dsh-client-ui-settings-models`).
The storefront is **pnpm talking to npm-compatible registries**, plus git and tarballs:

`PKG/dsh-plugin-manager/README.md:46`:
> "`inspect(spec, options)` reads what a spec names before anything installs: a registry name is asked
> of the registry through `pnpm view`, run in the profile directory so the same proxy and
> authentication settings apply as to the install; an absolute path has its `package.json` read; a git
> address or tarball answers only its form and the `host` it is fetched from."

The accepted spec grammar is *code*, in
`PKG/dsh-plugin-manager/lib/types/install-spec.js:parseInstallSpec`:

| Form | Example | Notes |
|---|---|---|
| registry name (+range) | `my-dsh-plugin`, `@acme/dsh-thing@1.2.3` | validated against `PACKAGE_NAME` regex, ≤214 chars |
| absolute path / `file:` / `link:` | `/Users/me/src/my-plugin` or `file:/…` | **must be absolute** — *"a relative path … would point inside it [the profile]"*; `.tgz` suffix ⇒ `tarball` |
| git | `github:acme/dsh-plugin`, `git+https://…`, `git@host:…`, `https://host/o/r[#ref]` | host extracted for the pre-install reachability check |
| tarball | `/path/x.tgz`, `https://host/x.tgz` | |
| anything else | — | `InvalidInstallSpecError` with a one-sentence reason |

Private registries are first-class. `PKG/dsh-plugin-manager/lib/types/registry.js`:
```js
export const OFFICIAL_NPM_REGISTRY = 'https://registry.npmjs.org/';
export const NPMMIRROR_REGISTRY = 'https://registry.npmmirror.com/';
```
and `registryPlan()` implements: *"A registry outside the configured set is asked alone, so a private
registry never falls through to a public one."* Both are re-exported browser-safe from
`@deepseek-ai/dsh-plugin-manager/registry`. Configuration defaults
(`PKG/dsh-plugin-manager/README.md:73-83`): `pnpmCommand: 'pnpm'`,
`fallbackRegistries: ['https://registry.npmmirror.com/']`, `inspectTimeoutMs: 20000`,
`githubConnectionTimeoutMs: 5000`, `lockWaitMs: 120000`, `idleTimeoutMs: 600000`.

GitHub specs get a pre-flight `git ls-remote` with credential helpers and prompts disabled
(`README.md:48`); failures other than network/timeout are handed to pnpm, *"including its HTTPS-to-SSH
fallback."*

### 5.2 How a team ships an internal plugin to colleagues

Ranked by how well each survives contact with the Plugin Manager:

**(1) Private npm registry (best).** Publish `@acme/dsh-thing` with a `dsh.bundle.patch`. Colleague:
`dsh plugin --profile web add @acme/dsh-thing` (or the Web **Add plugin** dialog → their registry).
Auto-enables, appears as a card with icon/locale text, gets a per-row toggle, uninstallable from the UI.
Requires the registry be in `pluginManager.registry` / pnpm config so it is asked and not treated as an
unknown public fallthrough.

**(2) Git URL (works; heavier).** `dsh plugin add github:acme/dsh-plugin`. `PKG/dsh-plugin-manager/README.md:131`
and the CLI warning (`PKG/dsh/plugin-BGnVfe_D.js:97`) flag the real cost:
> "dsh: git-hosted plugins build on install via their prepare script, which pnpm blocks until
> allowed — add the exact key pnpm printed above under allowBuilds in
> `<profile>/pnpm-workspace.yaml`, then re-run"

and per `README.md:63`, a git/tarball spec's compatibility **cannot be judged before install** — it is
judged after, and on rejection the operation restores `package.json` + `pnpm-lock.yaml` and reinstalls.
Approvals persist by package name and are not re-checked against the conversation.

**(3) Tarball** (`pnpm pack` → share the `.tgz`, or a URL). Same deferred-compat caveat as git.

**(4) Absolute local path (best for co-development).** `dsh plugin add /abs/path/to/checkout`. The
profile's `pnpm-workspace.yaml` already sets `nodeLinker: hoisted`, and app-boot has explicit support
for linked profile roots: "*A profile link to an external directory admits its importers to peer-aware
ancestor lookup, even without its own `package.json`*" (`PKG/dsh-app-boot/README.md:134`). Caveat from
`:139`: re-pointing a *previously published* link name at a different target is rejected even after
removal, and `:200` — "*Relinking a profile package needs a restart*".

**(5) Hand-edited patch row only** (no `dsh.bundle`): works, but the manager warns
`declares no dsh.bundle — installed as a plain dependency, not a profile layer`, the bundle card is
absent, and the row can only be toggled if it is addressable by id.

**Upgrade:** there is no auto-update. `PKG/dsh-client-ui-plugin-manager/README.md` — "*installed
plugins do not update automatically: upgrading means uninstalling and installing the new version*."
Also `PKG/dsh-plugin-manager/README.md:130` — "*Package replacements require restarting the process to
load a fresh JavaScript module generation.*"

**A `README` should say `dsh plugin add <pkg>`** — the Web dialog literally tells users that: "*the
dialog says a package name is what follows `dsh plugin add` in a README*."

### 5.3 Version-compatibility gates

Three separate mechanisms, only two of which actually block:

1. **Peer ranges — blocks.** `evaluatePluginCompatibility`
   (`PKG/dsh-app-boot/lib/index.js:286-313`) walks `peerDependencies`, keeps only names equal to
   `@deepseek-ai/dsh` or starting with `@deepseek-ai/dsh-`, and tests each against
   `getDshRuntimeVersion()` with `{ includePrerelease: true }`. Any mismatch ⇒ issue. Missing DSH peers
   impose nothing. It is applied at **every** DSH-owned composition boundary: profile rows
   (`prepareProfileEntries`/`preflight`), bundle layers (`loadProfileDirectory`), and agent presets.
2. **Exact-version exemptions — the escape hatch.** `<profile>/compatibility.json` maps exact
   `name@version` → list of exact DSH versions (`PROFILE_COMPATIBILITY_FILENAME`, `lib/index.js:328`;
   `validatePluginVersionExemption`, `:348-351`). Deliberately *not* in `package.json`
   (`PKG/dsh-app-boot/README.md:56`): "neither a plugin upgrade nor a DSH upgrade inherits permission."
   Granting requires `acceptRisk: true` and a `runtimeVersion` equal to the current one
   (`lib/index.js:421-434`). A malformed file authorizes nothing, still applies the records it can read,
   and becomes **read-only** so DSH refuses to overwrite it. Surfaces: `dsh plugin --profile <p> allow-version
   <name@version> --dsh-version <exact> --accept-risk` / `revoke-version` / `version-exemptions`
   (`PKG/dsh/plugin-BGnVfe_D.js:16-48`), the `plugin_manager` tool's `list_version_exemptions` /
   `set_version_exemption`, and the Web page. Refusal error code is `incompatible-version` carrying
   `{name, version, runtimeVersion, peers}`.
3. **`engines.dsh` / `dsh.manifestVersion` — declarative only, no gate.**
   `PKG/dsh-package-manifest/README.md:93`.

Install-time vs startup-time (important asymmetry, `PKG/dsh-plugin-manager/README.md:63`):
* an `add`/`install` naming packages is checked **before pnpm runs** (local path: its own `package.json`;
  registry spec: resolved through `pnpm view` for the selected version) — "so nothing is downloaded and
  no build script runs";
* a **git or tarball** spec "needs the fetch itself, so it is judged after installation", then rolls back;
* **startup re-checks independently**, so a dependency nobody touched that has become incompatible
  "stays installed, the run reports a warning naming it, and profile startup denies it."

`getDshRuntimeVersion()` reads app-boot's **own** `package.json` version
(`lib/index.js:271-275`), i.e. the runtime version, not the plugin's.

### 5.4 Shipped-optional bundles (a distinct distribution shape)

`PKG/dsh-app-boot/lib/index.js:552-557`:
```js
const OPTIONAL_BUNDLES = [
	"@deepseek-ai/dsh-experimental-agent-team-profile",
	"@deepseek-ai/dsh-experimental-voice-input-bundle",
	"@deepseek-ai/dsh-experimental-auto-review",
	"@deepseek-ai/dsh-experimental-schedule-bundle"
];
```
These are runtime dependencies of the installation that declare `dsh.bundle.patch`, an `icon`, and
`./locale/*.json`. They are *shipped switched off*, never removable, and selected by no template — so
they appear in the Web Plugins page under "Official" with an **Experimental** tag for the user to turn
on. This is the pattern to copy if a team wants a plugin pre-staged but off by default: it requires
being a dependency of the *installation*, so it is only available to whoever builds the app image.

---

## 6. Explicitly NOT determined (flag list)

1. **The authoring cookbook is absent.** `docs/cookbook/adding-a-package.md` (referenced with a
   `#plugin-display-metadata` anchor by `PKG/dsh-app-boot/README.md:85` and
   `PKG/dsh-client-ui-plugin-manager/README.md`) is a monorepo-relative path and is not in the extract
   or in `app.asar`. Its existence is certain from the citations; its contents are unknown to me.
2. **The client build preset is absent.** `PKG/dsh-client-modules/README.md:74` and
   `PKG/dsh-client-hmr/README.md:32` reference "the shared Client tsdown preset" /
   "the shared preset stamps `client.js`". No tsdown config, `tsconfig.client.json`, or
   `tsconfig.host.json` ships in `node_modules`. So I can state *what the output must be*
   (`lib/client.js` + optional `client.<n>.js` chunks, lazy-CJS factory form, `require.async` for
   splits) but **not** how to configure the build or the exact `clientBundle(...)` helper invocation
   (referenced only in `PKG/dsh-api-remotes/README.md:60`: "The package-local
   `clientBundle(..., { hostPhase: true })`").
3. **There is no DSH plugin scaffolder in this extract.** `PKG/cordis/README.md:81` lists
   `create-cordis` ("Interactive project scaffolder"), but the package is not installed and there is no
   DSH-specific equivalent.
4. **No published plugin-Author schema for `dsh.client`.** `PKG/dsh-package-manifest` ships **only**
   `lib/index.js` containing `export {};` — the `.d.ts` files are missing from this install (they are
   in `files` but not present). I reconstructed the field set from the runtime validator in
   `dsh-client-modules`, which is authoritative for behavior but is not the declared type.
5. **`dsh.client.immediately` semantics** are only partly visible: it becomes a boolean on the graph
   row (`lib/index.js:402`) and is retained in `meta` (`:726`). I did not trace how the browser half
   schedules it.
6. **No evidence of a signature/allowlist/provenance mechanism** for third-party plugins beyond the
   pnpm/npm supply chain + the install-time approval gate. Absence of evidence in 290 READMEs is
   strong but not proof.
7. **Electron/Desktop specifics.** `dsh-desktop-runtime` is `"private": true`; the Desktop profile name
   `desktop` is *reserved* and the CLI rejects boot/config-dump for it (`PKG/dsh/README.md:20`), and
   "Desktop package operations remain owned by the Desktop shell"
   (`PKG/dsh-plugin-manager/README.md:135`). I did not determine how a desktop-specific third-party
   plugin would be installed.
