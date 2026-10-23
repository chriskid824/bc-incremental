/** `<package version>+<git short sha>` of this build, or `<version>+dev` (vite.config.ts). */
declare const __BUILD_ID__: string;

interface ImportMetaEnv {
  /** `demo` or `full`; unset or empty means `full` (src/platform/flavor.ts; vite.config.ts checks it). */
  readonly VITE_FLAVOR?: string;
}
