# akashic-scoreboard

プレイ記録を実行基盤へ報告する Akashic Engine 拡張。

ゲームが「このプレイヤーのスコアは 1200 だった」と報告すると、対応している実行基盤がそれを集計して統計として見せます。**集計も表示も実行基盤の仕事**で、この拡張が受け持つのは報告するところまでです。

## パッケージ

| パッケージ                                                                       | 読み手           | 役割                                               |
| -------------------------------------------------------------------------------- | ---------------- | -------------------------------------------------- |
| [@multi-indiegame/akashic-scoreboard](packages/akashic-scoreboard)               | ゲーム開発者     | コンテンツに入れる本体                             |
| [@multi-indiegame/akashic-scoreboard-plugin](packages/akashic-scoreboard-plugin) | 実行基盤の開発者 | 記録を受け取る側の橋渡し                           |
| [@multi-indiegame/akashic-scoreboard-serve](packages/akashic-scoreboard-serve)   | ゲーム開発者     | `akashic serve` で動作確認するための実行基盤の代役 |

## 設計の指針

**報告源はアクティブインスタンスに限ります。** パッシブインスタンスの報告は手元で書き換えられる恐れがあり、アクティブインスタンスはゲーム情報を集約して持っていると期待できるからです。

この判定は拡張ライブラリ自身が `g.game.isActiveInstance()` で行います。実行基盤が `g.game.external` をどこに生やすかに関わらず指針が保たれ、生える場所の取り決めを前提にしなくて済みます。

**記録をどう保存し、どう集計し、どう公開するかは実行基盤が決めます。** それが誰の記録かを決めるのも実行基盤です。この拡張はコンテンツが渡した playerId を文字列として運ぶだけです。

## 開発

```sh
npm install
npm run build
npm run format
```

## 仕様

[akashic-external-protocol](https://github.com/multi-indiegame/akashic-external-protocol) に従います。

## ライセンス

MIT
