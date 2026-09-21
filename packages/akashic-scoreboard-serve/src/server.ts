/**
 * akashic serve 用の scoreboard バックエンド（サーバ側）。
 *
 * ゲーム開発者が sandbox.config.js の `server.external` から参照する。ブラウザ側
 * （`client.external`）はパッケージ名そのものが指す lib/index.js のほう。使い方は
 * このパッケージの README.md を見ること。
 *
 * WHY: 実行基盤向けの @multi-indiegame/akashic-scoreboard-plugin とは読み手が違う
 * ので、パッケージを分けている。akashic serve は `server.external` に書かれた
 * パスを require し、その `module.exports` を引数なしで呼んで、戻り値を
 * アクティブインスタンスの `g.game.external.<名前>` に入れる。
 *
 * WHY: こちらは Node の中で動くので、client.external 側のプラグインと違って
 * require が使える。バンドルは要らない。
 */
import * as fs from "fs";
import * as path from "path";
import {
    DEFAULT_SNAPSHOT_OPERATION_CODE,
    RecordSnapshot,
    SnapshotTransport,
} from "./channel";
import { ServeOrigin, SnapshotSender } from "./playlog";
import { resolveServeOrigin } from "./serve-origin";
import {
    ScoreRecordPatch,
    ScoreRecordSubject,
    ScoreboardBackend,
    ScoreboardLimits,
    ScoreboardPlugin,
    RejectedRecordEntry,
} from "@multi-indiegame/akashic-scoreboard-plugin";

/** 記録の書き出し先。指定されたときだけファイルへ書く */
const OUTPUT_PATH_ENV = "AKASHIC_SCOREBOARD_SERVE_OUTPUT";

/** akashic serve の待ち受け先。既定は cli-serve の設定から拾う */
const ORIGIN_ENV = "AKASHIC_SCOREBOARD_SERVE_ORIGIN";

/**
 * WHY: キー名も playerId もコンテンツが決めた文字列なので、`toString` や
 * `__proto__` のような名前も来る。素のオブジェクトだと継承したプロパティに
 * 当たってしまい、記録がそちらへ書かれて画面にも出てこない。
 */
function emptyRecords(): RecordSnapshot {
    return { play: Object.create(null), players: Object.create(null) };
}

/**
 * 本番の実行基盤の代役として、記録をその場でまとめて保持する。
 *
 * WHY: 差分のまま出しても読めないので、実行基盤がやるのと同じマージ（後勝ち・
 * null で削除）をここでも行う。動作確認で見たいのは「いま何が記録されているか」
 * だから。
 */
class ServeBackend implements ScoreboardBackend {
    _records: RecordSnapshot = emptyRecords();
    _outputPath: string | null;
    _sender: SnapshotSender;
    _warnedWriteFailure = false;

    constructor(
        outputPath: string | null,
        origin: ServeOrigin,
        transport: SnapshotTransport,
        operationCode: number,
    ) {
        this._outputPath = outputPath;
        this._sender = new SnapshotSender(origin, transport, operationCode);
    }

    record(
        subject: ScoreRecordSubject,
        patch: ScoreRecordPatch,
        rejected: RejectedRecordEntry[],
    ): void {
        // WHY: 記録が 1 つも通らなかった報告で枠を作らない。作ると、実行基盤が
        // 数えない相手（拡張ライブラリ側で弾かれた報告や、キーを消すだけの
        // 報告）でプレイヤーの一覧が際限なく増える
        const keys = Object.keys(patch);
        const changed = keys.length > 0 && this._merge(subject, patch);
        // WHY: playerId はコンテンツが決めた任意の文字列。素のまま出すと、
        // 改行を混ぜてログの行を偽装できる
        const label =
            subject.kind === "play"
                ? "play"
                : `player ${JSON.stringify(subject.playerId)}`;
        console.log(
            `[akashic-scoreboard-serve] ${label}: ${JSON.stringify(patch)}`,
        );
        for (const entry of rejected) {
            // WHY: 破棄した値こそ知りたい。本番の実行基盤もここをログに残す
            console.warn(
                `[akashic-scoreboard-serve] 記録できない値を破棄しました (key: ${entry.key}, reason: ${entry.reason})`,
            );
        }
        // WHY: 記録が動いていなければ書き出しも送信もしない。弾かれた報告を
        // 繰り返されても、ファイルと playlog を巻き込まない
        if (changed) {
            this._write();
            this._sender.send(this._records);
        }
    }

    /** 記録が動いたら true。動かなければ相手の枠も残さない */
    _merge(subject: ScoreRecordSubject, patch: ScoreRecordPatch): boolean {
        if (subject.kind === "play") {
            merge(this._records.play, patch);
            return true;
        }
        const playerId = subject.playerId;
        const existing = this._records.players[playerId];
        const target = existing ?? (Object.create(null) as RecordValues);
        merge(target, patch);
        // WHY: 記録が 1 つも残らない相手は持たない。キーを消すだけの報告を
        // 別の名前で繰り返されると、空の枠だけが積み上がる
        if (Object.keys(target).length === 0) {
            if (existing) {
                delete this._records.players[playerId];
                return true;
            }
            return false;
        }
        this._records.players[playerId] = target;
        return true;
    }

    _write(): void {
        // WHY: 頼まれていないファイルを残すと、利用者が後で消すことになる
        if (!this._outputPath) {
            return;
        }
        const temp = `${this._outputPath}.tmp`;
        try {
            // WHY: 親ディレクトリが無いだけで毎回失敗するのは、書き出し先を
            // 指定した人の意図と合わない
            fs.mkdirSync(path.dirname(this._outputPath), { recursive: true });
            // WHY: 直接上書きすると、途中で落ちたときに壊れた JSON が残る
            fs.writeFileSync(
                temp,
                JSON.stringify(this._records, null, 4) + "\n",
            );
            fs.renameSync(temp, this._outputPath);
        } catch (err) {
            // WHY: 記録のたびにスタックトレースを出すと、動作確認の妨げになる
            if (!this._warnedWriteFailure) {
                this._warnedWriteFailure = true;
                console.warn(
                    `[akashic-scoreboard-serve] 記録の書き出しに失敗しました: ${(err as Error).message}`,
                );
            }
        }
    }
}

type RecordValues = { [key: string]: number | string | boolean };

function merge(target: RecordValues, patch: ScoreRecordPatch): void {
    for (const key of Object.keys(patch)) {
        const value = patch[key];
        if (value === null) {
            delete target[key];
        } else {
            target[key] = value;
        }
    }
}

interface ScoreboardServeOptions {
    /**
     * 記録をファイルにも書き出したいときの書き出し先。
     * 指定しなければファイルは作らない（記録はメモリ上にだけ持つ）。
     * 相対パスは akashic serve を起動したディレクトリから解決する。
     */
    outputPath?: string;
    /** akashic serve の待ち受け先。省略すると cli-serve の設定から拾う */
    serveOrigin?: string;
    /** 本番の実行基盤に合わせて上限を試したいときに指定する */
    limits?: ScoreboardLimits;
    /**
     * 記録をブラウザ側へ運ぶときの playlog イベントの種別。既定は `message`。
     *
     * **通常は指定しない。** coe コンテンツ向けの
     * `@multi-indiegame/akashic-scoreboard-serve-coe` が `operation` を渡す。
     * 理由は channel.ts の `SnapshotTransport` を参照。
     */
    transport?: SnapshotTransport;
    /**
     * OperationEvent で運ぶときの操作プラグインコード。
     * 既定は `DEFAULT_SNAPSHOT_OPERATION_CODE`（0x6d69）。
     *
     * `transport` が `operation` のときだけ意味がある。コンテンツが同じ番号の
     * 操作プラグインを登録していて衝突するときに、利用者が逃がすためのもの。
     */
    operationCode?: number;
}

/**
 * 指定された操作プラグインコードを読む。
 *
 * WHY: 小数や負の数をそのまま流すと、コンテンツ側の操作プラグインの照合が
 * 静かに外れる。壊れた指定は既定値へ落として、落としたことを言う。
 */
function readOperationCode(specified: number | undefined): number {
    if (specified === undefined) {
        return DEFAULT_SNAPSHOT_OPERATION_CODE;
    }
    if (
        typeof specified === "number" &&
        isFinite(specified) &&
        Math.floor(specified) === specified &&
        specified >= 0
    ) {
        return specified;
    }
    console.warn(
        `[akashic-scoreboard-serve] 操作プラグインコードの指定を読めませんでした（${JSON.stringify(specified)}）。` +
            `既定の 0x${DEFAULT_SNAPSHOT_OPERATION_CODE.toString(16)} を使います`,
    );
    return DEFAULT_SNAPSHOT_OPERATION_CODE;
}

/**
 * `configure()` で渡された設定。
 *
 * WHY: akashic serve はこのモジュールを require して**引数なしで**呼ぶので、
 * 設定を渡す口が呼び出しの引数以外に要る。sandbox.config.js は JavaScript なので、
 * そこから先に `configure()` を呼んでもらう。akashic serve が require するのと
 * 同じ解決結果（同じパス）なら、Node のモジュールキャッシュで同じインスタンスに
 * なるため、ここに置いた設定が使われる。
 *
 * WHY: 設定のためだけに別ファイルを作らせない。sandbox.config.js 1 枚で済む。
 */
let _configured: ScoreboardServeOptions = {};

/**
 * akashic serve に渡す external を作る。
 *
 * 既定の設定でよければ sandbox.config.js からこのモジュールをそのまま参照する。
 * 設定を変えたいときは `configure()` を使う。
 */
function createScoreboardExternal(options: ScoreboardServeOptions = {}) {
    // WHY: 呼び出しの引数を優先する。自分のファイルから直接呼ぶ使い方を
    // 残しておくため（akashic serve からの呼び出しは引数なし）
    options = { ..._configured, ...options };
    const specifiedPath = options.outputPath ?? process.env[OUTPUT_PATH_ENV];
    const outputPath = specifiedPath ? path.resolve(specifiedPath) : null;
    const origin = resolveServeOrigin(options.serveOrigin);
    const transport: SnapshotTransport =
        options.transport === "operation" ? "operation" : "message";
    const operationCode = readOperationCode(options.operationCode);
    const backend = new ServeBackend(
        outputPath,
        origin,
        transport,
        operationCode,
    );
    const plugin = new ScoreboardPlugin({
        backend: backend,
        limits: options.limits,
    });
    console.log(
        "[akashic-scoreboard-serve] 記録を受け取ります。" +
            "akashic serve の画面の「スコアボード」タブで確認できます。",
    );
    // WHY: 推定した送信先が外れていると、記録が別のサービスへ飛ぶ。どこへ送るかを
    // 必ず見せる
    console.log(
        `[akashic-scoreboard-serve] 記録の送信先: ${origin.protocol}://${origin.hostname}:${origin.port}`,
    );
    // WHY: どの種別のイベントに載せているかを出す。コンテンツ側で playlog の
    // イベントを扱っている人が、何が流れてくるかをここで確かめられるようにする
    console.log(
        transport === "operation"
            ? "[akashic-scoreboard-serve] 記録を載せる playlog イベント: OperationEvent" +
                  `（操作プラグインコード 0x${operationCode.toString(16)}）`
            : "[akashic-scoreboard-serve] 記録を載せる playlog イベント: MessageEvent",
    );
    if (outputPath) {
        console.log(
            `[akashic-scoreboard-serve] 記録の書き出し先: ${outputPath}`,
        );
    }
    return plugin.createExternal();
}

namespace createScoreboardExternal {
    export type Options = ScoreboardServeOptions;

    /**
     * 設定を渡す。**sandbox.config.js の中で呼ぶこと。**
     *
     * ```js
     * const scoreboardServe = require(
     *   "@multi-indiegame/akashic-scoreboard-serve/server.js",
     * );
     * scoreboardServe.configure({ outputPath: "./tmp/records.json" });
     * ```
     *
     * 指定したキーだけが変わる。何度呼んでも構わず、後の指定で上書きされる。
     * プレイが作られるたびに読み直されるので、`akashic serve` を起動したまま
     * sandbox.config.js を書き換えて、プレイを作り直せば新しい設定になる。
     */
    export function configure(options: Options): void {
        _configured = { ..._configured, ...options };
    }
}

// WHY: akashic serve は require() した module.exports を引数なしで呼び、その
// 戻り値を external にする。`export default` だと exports.default に入って
// 呼べないので、CommonJS の export 代入にする
export = createScoreboardExternal;
