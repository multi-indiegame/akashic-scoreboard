/**
 * akashic serve 用の scoreboard バックエンド。
 *
 * ゲーム開発者が sandbox.config.js の server.external から参照する。使い方は
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
import { RecordSnapshot } from "./channel";
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

    constructor(outputPath: string | null, origin: ServeOrigin) {
        this._outputPath = outputPath;
        this._sender = new SnapshotSender(origin);
    }

    record(
        subject: ScoreRecordSubject,
        patch: ScoreRecordPatch,
        rejected: RejectedRecordEntry[],
    ): void {
        // WHY: 記録が 1 つも通らなかった報告で枠を作らない。作ると、実行基盤が
        // 数えない相手（拡張ライブラリ側で弾かれた報告）でプレイヤーの一覧が
        // 際限なく増える
        const keys = Object.keys(patch);
        if (keys.length > 0) {
            const target =
                subject.kind === "play"
                    ? this._records.play
                    : (this._records.players[subject.playerId] ??=
                          Object.create(null));
            merge(target, patch);
        }
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
            // WHY: 捨てた値こそ知りたい。本番の実行基盤もここをログに残す
            console.warn(
                `[akashic-scoreboard-serve] 記録できない値を捨てました (key: ${entry.key}, reason: ${entry.reason})`,
            );
        }
        // WHY: 記録が動いていなければ書き出しも送信もしない。弾かれた報告を
        // 繰り返されても、ファイルと playlog を巻き込まない
        if (keys.length > 0) {
            this._write();
            this._sender.send(this._records);
        }
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

function merge(
    target: { [key: string]: number | string | boolean },
    patch: ScoreRecordPatch,
): void {
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
}

/**
 * akashic serve に渡す external を作る。
 *
 * 既定の設定でよければ sandbox.config.js からこのモジュールをそのまま参照する。
 * ファイルへの書き出しや上限を変えたいときは、自分のファイルからこの関数を
 * 呼んで返す。
 */
function createScoreboardExternal(options: ScoreboardServeOptions = {}) {
    const specifiedPath = options.outputPath ?? process.env[OUTPUT_PATH_ENV];
    const outputPath = specifiedPath ? path.resolve(specifiedPath) : null;
    const origin = resolveServeOrigin(options.serveOrigin);
    const backend = new ServeBackend(outputPath, origin);
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
    if (outputPath) {
        console.log(
            `[akashic-scoreboard-serve] 記録の書き出し先: ${outputPath}`,
        );
    }
    return plugin.createExternal();
}

namespace createScoreboardExternal {
    export type Options = ScoreboardServeOptions;
}

// WHY: akashic serve は require() した module.exports を引数なしで呼び、その
// 戻り値を external にする。`export default` だと exports.default に入って
// 呼べないので、CommonJS の export 代入にする
export = createScoreboardExternal;
