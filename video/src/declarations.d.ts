declare module "*.woff2" {
  const url: string;
  export default url;
}
declare module "*.svg" {
  const url: string;
  export default url;
}
// The app reads Vite's import.meta.env (absent in this bundle; app/src/lib/config.ts guards it).
interface ImportMeta {
  readonly env: { readonly DEV?: boolean; readonly PROD?: boolean; readonly VITE_ORDER_API?: string; readonly VITE_RELAY_URL?: string };
}
