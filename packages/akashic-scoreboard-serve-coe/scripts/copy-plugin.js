/*
 * @multi-indiegame/akashic-scoreboard-serve のブラウザ側プラグインを、この
 * パッケージへ複写する（lib/index.js）。
 *
 * WHY: ブラウザ側は運び方を見分ける必要が無い（どちらの種別で来ても同じ画面を
 * 出す）ので、プラグインは本体パッケージと同じもので足りる。
 *
 * WHY: それでも複写して同梱するのは、client.external に書くパスを
 * このパッケージだけで完結させるため。本体を直接指させると、依存の置かれ方に
 * よっては require.resolve が通らない。
 *
 * WHY: 参照ではなく複写なのは、client.external に渡せるのが「自己完結した
 * 1 ファイル」だから。あちらは require() の無いスコープで評価される。
 */
const fs = require("fs");
const path = require("path");

const source = require.resolve("@multi-indiegame/akashic-scoreboard-serve");
const dest = path.join(__dirname, "..", "lib", "index.js");

const banner =
    "/* このファイルは @multi-indiegame/akashic-scoreboard-serve のブラウザ側プラグインの複写です。直接編集しないこと。 */\n";

fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, banner + fs.readFileSync(source, "utf8"));
