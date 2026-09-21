/**
 * coe コンテンツ用の、akashic serve 向け scoreboard バックエンド（サーバ側）。
 *
 * ゲーム開発者が sandbox.config.js の `server.external` から参照する。ブラウザ側
 * （`client.external`）はパッケージ名そのものが指す lib/index.js のほう（中身は
 * @multi-indiegame/akashic-scoreboard-serve のものと同じ複写）。使い方は
 * このパッケージの README.md を見ること。
 *
 * **中身は @multi-indiegame/akashic-scoreboard-serve と同じ**で、違うのは記録を
 * ブラウザ側へ運ぶ playlog イベントの種別だけ（MessageEvent ではなく
 * OperationEvent）。
 *
 * WHY: coe (@akashic-extension/coe) の Scene は**届いた g.MessageEvent を
 * すべて握りつぶす**（Scene の JSDoc にも明記されている）。握りつぶされるのは
 * アクティブインスタンスのイベントフィルタなので、サーバ側が流したスナップ
 * ショットはティックにも playlog のダンプにも現れず、coe コンテンツでは
 * 「スコアボード」タブが永久に空のままになる。coe のフィルタが落とすのは
 * 0x20 だけで、それ以外の種別は素通しする。
 *
 * WHY: **パッケージを分けて、既定は MessageEvent のまま据え置く。**
 * OperationEvent は本来、コンテンツが game.json の `operationPlugins` で宣言した
 * code の操作を、コンテンツ自身が受け取るための種別である。こちらは code を
 * 宣言せずに占有し、読むのもコンテンツではなくブラウザ側の道具なので、本来の
 * 使い方からは外れている。coe のために避けられないときだけ選べるようにする。
 */
import createScoreboardExternal = require("@multi-indiegame/akashic-scoreboard-serve/server.js");

/**
 * coe コンテンツ向けの設定。
 *
 * WHY: 種別はこのパッケージが決めるので、利用者には渡させない。渡せると、
 * このパッケージを使いながら MessageEvent に戻すという、名前と中身が食い違う
 * 組み合わせが作れてしまう。
 */
type ScoreboardServeCoeOptions = Omit<
    createScoreboardExternal.Options,
    "transport"
>;

/**
 * akashic serve に渡す external を作る。
 *
 * 既定の設定でよければ sandbox.config.js からこのモジュールをそのまま参照する。
 * 設定を変えたいときは `configure()` を使う。
 */
function createScoreboardExternalForCoe(
    options: ScoreboardServeCoeOptions = {},
) {
    return createScoreboardExternal({ ...options, transport: "operation" });
}

namespace createScoreboardExternalForCoe {
    export type Options = ScoreboardServeCoeOptions;

    /**
     * 設定を渡す。**sandbox.config.js の中で呼ぶこと。**
     *
     * ```js
     * const scoreboardServe = require(
     *   "@multi-indiegame/akashic-scoreboard-serve-coe/server.js",
     * );
     * scoreboardServe.configure({ operationCode: 30000 });
     * ```
     *
     * 指定したキーだけが変わる。何度呼んでも構わず、後の指定で上書きされる。
     */
    export function configure(options: Options): void {
        createScoreboardExternal.configure(options);
    }
}

// WHY: akashic serve は require() した module.exports を引数なしで呼び、その
// 戻り値を external にする。`export default` だと exports.default に入って
// 呼べないので、CommonJS の export 代入にする
export = createScoreboardExternalForCoe;
