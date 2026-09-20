# Changesets

パッケージの version と CHANGELOG は [Changesets](https://changesets.dev) で管理します。

## 変更を入れる PR で

```sh
npx changeset
```

変更したパッケージと bump の種類（patch / minor / major）を選び、変更内容を書きます。
できた `.changeset/*.md` を PR に含めてください。

changeset が要るのは、npm に publish されるファイルが変わるときだけです。選ぶのも、中身が変わったパッケージだけにします。

- 要る: `src` の変更、`package.json` の依存や exports の変更、パッケージ内の README（tarball に含まれ npm のページに出る）の変更
- 要らない: CI や `.changeset` の設定、リポジトリ直下の README など、publish されるファイルが変わらない変更

本体（`@multi-indiegame/akashic-scoreboard`）の major を出して依存側の範囲が外れる場合、
依存側（`@multi-indiegame/akashic-scoreboard-plugin` と `@multi-indiegame/akashic-scoreboard-serve`）は
自動で patch になります。それが依存側にとっても破壊的変更になるときは、
依存側の bump も changeset で明示してください。

`packages/akashic-scoreboard/src/protocol.ts` は 3 パッケージが共有しています。
ここを変えたときは、どこまで影響が届くかを確かめて changeset を選んでください。

### serve はブラウザ側の依存をバンドルしています

`@multi-indiegame/akashic-scoreboard-serve` の `plugin.js` は、
`@multi-indiegame/akashic-serve-extension-dock` を畳み込んでいます
（akashic serve の client.external の評価環境に `require()` が無いため）。
依存は devDependencies なので Changesets は追従しません。
**ドックを更新したときは、changeset に serve を含めてください。**

## リリース

main にマージされると GitHub Actions が「Version Packages」PR を作ります（以降のマージで更新され続けます）。
その PR をマージすると、npm に無い version のパッケージだけが publish され、
パッケージごとに `<パッケージ名>@<version>` のタグと GitHub Release が作られます。
