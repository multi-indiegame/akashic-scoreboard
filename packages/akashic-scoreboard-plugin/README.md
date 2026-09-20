# @multi-indiegame/akashic-scoreboard-plugin

プレイ記録を受け取るための Akashic Engine 拡張（コンテンツ実行基盤側のプラグイン）。

コンテンツが [@multi-indiegame/akashic-scoreboard](../akashic-scoreboard) で報告した記録を、実行基盤が受け取るための橋渡しです。**ゲーム開発者向けではありません**（そちらは本体パッケージ、動作確認は [-serve](../akashic-scoreboard-serve)）。

## 組み込み方

この拡張は**アクティブインスタンス側**に生やします。headless-driver の `RunnerV3` なら `externalValue` に載せます。

```typescript
import { ScoreboardPlugin } from "@multi-indiegame/akashic-scoreboard-plugin";

const plugin = new ScoreboardPlugin({
  backend: {
    record(subject, patch, rejected) {
      // subject.kind === "player" なら subject.playerId の記録
      // subject.kind === "play" なら部屋そのものの記録
      store(subject, patch);
      for (const entry of rejected) {
        logger.warn("dropped", entry.key, entry.reason);
      }
    },
  },
  limits: { keysPerPlayer: 100, stringLength: 140 },
});

const runner = runnerManager.createRunner({
  executionMode: "active",
  externalValue: { scoreboard: plugin.createExternal() },
  // ...
});
```

生える場所を決めるのは実行基盤ですが、**アクティブ側にだけ生やすことを勧めます**。拡張ライブラリ自身が `g.game.isActiveInstance()` で報告元を絞っているので指針は生やす場所に依存しませんが、生やさなければパッシブ側で余計な処理も通信も起きません。

## 実行基盤の責務

このプラグインは呼び出しを橋渡しするだけで、**セキュリティ境界ではありません**（[PROTOCOL.md](https://github.com/multi-indiegame/akashic-external-protocol/blob/main/PROTOCOL.md) 8 章）。コンテンツは同一オリジンなら `g.game.external` を直接叩けるので、次はすべて実行基盤の責務です。

- **記録をどう保存し、どれだけ保持し、どう集計して公開するか**
- **その playerId が誰かを決めること。** プラグインはコンテンツが渡した文字列をそのまま運びます。知らない playerId の記録をどう扱うかは実装側で決めてください
- **上限の最終的な判定。** プラグインも `limits` で検証しますが、それは早く気づくためのものです
- **廃棄した値をログに残すこと。** `record()` の `rejected` がそれです。投稿者から「値は送っているのに記録されない」と問い合わせを受けたときの手がかりとするためです。

## マージの決まり

`record()` が受け取るのは**差分**です。実装側で次のようにまとめてください。

- 同じキーを後から受け取ったら上書きする
- 値が `null` ならそのキーを消す

## API

### `new ScoreboardPlugin({ backend, limits? })`

`limits` を渡すとコンテンツ側からも読めるので、ライブラリが送る前の段階でも同じ上限で揃います。省略すると拡張ライブラリの既定値（キー数 100 / string 140 文字）が使われます。

**キー数の上限は、1 回の報告ではなく、相手ごとに積み上がった記録全体に掛かります。** プラグインが受け取ったキー名を控えて判定するので、実装側で数える必要はありません。プラグインは 1 プレイにつき 1 つ作ってください。

### `plugin.createExternal()`

`g.game.external.scoreboard` に入れるオブジェクトを返します。

### 再検証のための関数

`normalizeRecordPatch()` と `isValidRecordKey()` を再エクスポートしています。プラグインを通さない経路を自前で持つ場合は、これを使って同じ判定をしてください。その経路でもキー数の上限を積み上がった記録全体に掛けるには、`normalizeRecordPatch()` の第 3 引数に、その相手について既に記録されているキーを `{ [キー名]: true }` の形で渡してください。

## ライセンス

MIT
