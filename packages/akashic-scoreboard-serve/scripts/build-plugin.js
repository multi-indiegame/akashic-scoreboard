/*
 * src/plugin.ts → plugin.js。
 *
 * WHY: akashic serve は client.external にパスを渡された 1 ファイルを、
 * module と exports しか無いスコープで評価する。require() が無いので、
 * 依存は全部バンドルで畳んでおかなければならない。
 *
 * WHY: format:"iife" + globalName で、出力は `var X = (() => { ... })();` になる。
 * akashic serve が要求する module.exports への代入は footer で行う。entry 側に
 * `module.exports = ...` と書くと esbuild がそのファイルを CommonJS と判定して
 * ラッパーで包み、`module` が akashic serve のものではなくラッパー内部のものを指してしまう。
 *
 * WHY: charset:"utf8" が無いと日本語の文字列リテラルが \u エスケープに化ける。
 */
const path = require("path");
const esbuild = require("esbuild");

const root = path.join(__dirname, "..");

esbuild
    .build({
        entryPoints: [path.join(root, "src", "plugin.ts")],
        outfile: path.join(root, "plugin.js"),
        bundle: true,
        format: "iife",
        globalName: "__scoreboardServePlugin",
        target: "es2018",
        charset: "utf8",
        legalComments: "none",
        banner: {
            js: "/* このファイルは src/plugin.ts から生成されています。直接編集しないこと。 */",
        },
        footer: {
            js: "module.exports = __scoreboardServePlugin.default;",
        },
    })
    .catch(() => process.exit(1));
