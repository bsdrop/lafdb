// build.mjs — esbuild build script
// Usage: node build.mjs        (production)
//        node build.mjs --dev  (dev: sourcemap, watch)
import * as esbuild from "esbuild";
import { readFile, readdir, writeFile } from "fs/promises";
import path from "path";

const dev = process.argv.includes("--dev");
const watch = process.argv.includes("--watch");
const withSourceMap = process.argv.includes("--sourcemap");

function minifyHtmlInTemplateLiteral(body) {
  return body
    .replace(/\n[ \t]*/g, " ")    // TODO: what if pre, textarea?
    .replace(/>\s+</g, "><")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function looksLikeCss(body) {
  return /[a-z#._[\-][^{]*\{[^}]*:[^}]*;/.test(body);
}

async function minifyCssInTemplateLiteral(body) {
  // ${...} 표현식을 임시 placeholder로 치환 (esbuild transform 에러 방지)
  const placeholders = [];
  const cssWithPlaceholders = body.replace(/\$\{[^}]+\}/g, (m) => {
    const idx = placeholders.length;
    placeholders.push(m);
    return `--tpl-expr-${idx}:0`; // 유효한 CSS 문법 형태 유지
  });

  try {
    const result = await esbuild.transform(cssWithPlaceholders, { loader: "css", minify: true });
    let minified = result.code.trim();
    // placeholder 복원
    placeholders.forEach((expr, idx) => {
      minified = minified.replace(new RegExp(`--tpl-expr-${idx}:0`, "g"), expr);
    });
    return minified;
  } catch (_) {
    return body;
  }
}

const htmlTplPlugin = {
  name: "html-tpl",
  setup(build) {
    build.onLoad({ filter: /\.(ts|js)$/, namespace: "file" }, async (args) => {
      const src = await readFile(args.path, "utf8");
      // 템플릿 리터럴 매칭 (html`...` 또는 css`...`)
      const out = src.replace(/(html|css)`([^`\\]*(?:\\.[^`\\]*)*)`/gs, (match, tag, body) => {
        if (tag === "html") {
          return "`" + minifyHtmlInTemplateLiteral(body) + "`";
        }
        if (tag === "css") {
          return "`" + body.replace(/\s+/g, " ").trim() + "`";
        }
        return match;
      });
      
      const loader = args.path.endsWith(".ts") ? "ts" : "js";
      return { contents: out, loader };
    });
  },
};

/** @type {import('esbuild').BuildOptions} */
const common = {
  charset: "utf8",
  minify: true, minifyIdentifiers: false,
  sourcemap: withSourceMap ? (dev ? "inline" : "external") : false,
  sourcesContent: withSourceMap && dev,
  target: ["chrome103", "firefox100", "safari16"],
  plugins: [htmlTplPlugin],
};


const scripts = [
  { entryPoints: ["src/player/player.ts"], bundle: false, format: "esm", outfile: "public/player.js" },
  { entryPoints: ["src/player/player-page.ts"], bundle: true, format: "iife", outfile: "public/player-page.js" },
  { entryPoints: ["src/index.ts"], bundle: true, format: "iife", outfile: "public/index.js" },
  { entryPoints: ["src/item.ts"], bundle: true, format: "iife", outfile: "public/item.js" },
  { entryPoints: ["src/history.ts"], bundle: true, format: "iife", outfile: "public/history.js" },
  { entryPoints: ["src/common.ts"], bundle: true, format: "iife", outfile: "public/common.js" },
  { entryPoints: ["src/accessible.ts"], bundle: true, format: "iife", outfile: "public/accessible.js" },
];

const css = {
  entryPoints: [
    "src/styles/player.css",
    "src/styles/index.css",
    "src/styles/item.css",
    "src/styles/history.css",
  ],
  outdir: "public",
  loader: { ".css": "css" },
};

async function build() {
  const contexts = await Promise.all([
    ...scripts.map((s) => esbuild.context({ ...common, ...s })),
    esbuild.context({ ...common, ...css }),
  ]);

  if (watch) {
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log("[esbuild] watching...");
  } else {
    await Promise.all(contexts.map((ctx) => ctx.rebuild()));
    await Promise.all(contexts.map((ctx) => ctx.dispose()));
    if (!dev && !withSourceMap) {
      await stripSourceMapComments("public");
    }
    console.log(`[esbuild] build done (${dev ? "dev" : "prod"})`);
  }
}

async function stripSourceMapComments(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await stripSourceMapComments(fullPath);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!fullPath.endsWith(".js") && !fullPath.endsWith(".css")) continue;
    const content = await readFile(fullPath, "utf8");
    const stripped = content
      .replace(/\n\/\/# sourceMappingURL=.*?\.map\s*$/u, "\n")
      .replace(/\n\/\*# sourceMappingURL=.*?\.map \*\/\s*$/u, "\n");
    if (stripped !== content) {
      await writeFile(fullPath, stripped);
    }
  }
}

build().catch((e) => { console.error(e); process.exit(1); });
