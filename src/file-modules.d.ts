// `import x from "./f.ext" with { type: "file" }` is the file's path (src/embedded.ts); bun-types types only some extensions.
declare module "*.md" { const path: string; export default path; }
declare module "*.css" { const path: string; export default path; }
