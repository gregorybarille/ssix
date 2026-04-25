/*
 * Ambient module declarations for non-TS assets.
 *
 * TypeScript 6 enforces TS2882 ("Cannot find module or type
 * declarations for side-effect import") on bare imports like
 * `import "./globals.css"`. Vite handles these fine at runtime, but
 * the type checker needs declarations. We declare them as bare
 * untyped modules here rather than pulling in `vite/client` (which
 * also brings in import.meta.env / asset URL types we don't use).
 */
declare module "*.css";
