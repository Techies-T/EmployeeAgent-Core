# デジタル庁 行政手続等の棚卸調査 MCP 利用・分析ガイド

## 概要
本ガイドは、デジタル庁が公表している「行政手続等の棚卸調査結果」（令和6年度・令和7年度）を対象とした MCP サービス（`admin-procedures`）のデータ構造、利用可能なツール、および AI エージェントによるダッシュボード生成手順を解説します。

---

## 1. 収録データセット仕様

リポジトリには、以下の 2 年分の全数調査データが Parquet 形式（`datasets/*/data.parquet`）で同梱されています。

| データセット ID | 調査対象年度 | 手続件数 | 主な特徴・列構成 |
| :--- | :--- | :--- | :--- |
| `procedures-survey-r7` | 令和7年度（2025年11月時点） | **76,275件** | 最新全数調査。実施府省庁が単一値化され、関連条項・根拠法令が充実（全46列）。 |
| `procedures-survey-r6` | 令和6年度（2024年11月時点） | **75,071件** | 前年度調査。オンライン化実施状況に「一部実施済」区分を含む。 |

### 主な分析可能ディメンション
- **所管府省庁**（38府省庁）
- **手続類型**（1 申請等、2-1 申請等に基づく処分通知等、3 縦覧等、4 作成・保存等）
- **事務区分**（1 自治事務、2 第1号法定受託事務、3 第2号法定受託事務、4 地方の事務でない）
- **オンライン化の実施状況**（1 実施済、2 未実施、3 適用除外、4 その他）
- **検討時の懸念点・ボトルネック**（費用対効果、紙原本の必要性、システム未整備、制度改正困難など）
- **個人ライフイベント**（死亡・相続、引越し、出生・こども、医療・健康、税金、就職・転職など 14分野）
- **法人ライフイベント**（法人の設立、情報変更、入札・契約、合併・分割、承継・廃業など）
- **添付書類**（住民票、戸籍、登記事項証明書、印鑑登録証明書などの提出義務状況）

---

## 2. 利用可能な MCP ツール一覧

ZTA Gateway の `analyst` ロールでは、以下の 4 つのツールが提供されます。

### ① `list_datasets`
利用可能なデータセット一覧（ID、タイトル、発行者、レコード数）を取得します。
```json
{ "method": "tools/call", "params": { "name": "list_datasets", "arguments": {} } }
```

### ② `inspect_dataset`
指定したデータセットのフィールド定義、データ型、基本統計情報を取得します。
```json
{
  "method": "tools/call",
  "params": {
    "name": "inspect_dataset",
    "arguments": { "dataset_id": "procedures-survey-r7" }
  }
}
```

### ③ `query_records`
個別手続の詳細を検索・フィルタリングします。
```json
{
  "method": "tools/call",
  "params": {
    "name": "query_records",
    "arguments": {
      "dataset_id": "procedures-survey-r7",
      "where": { "所管府省庁": "デジタル庁", "オンライン化の実施状況": "1 実施済" },
      "limit": 10
    }
  }
}
```

### ④ `summarize_records`
指定ディメンションでのグループ集計、カウント、クロス集計を行います。
```json
{
  "method": "tools/call",
  "params": {
    "name": "summarize_records",
    "arguments": {
      "dataset_id": "procedures-survey-r7",
      "group_by": ["事務区分"],
      "metrics": ["count"]
    }
  }
}
```

---

## 3. ライセンスと免責事項

- **プログラム本体**: [MIT License](../services/administrative-procedures-mcp/LICENSE)（Copyright (c) 2026 Digital Agency, Government of Japan）
- **調査データ**: デジタル庁オープンデータ（[政府標準利用規約 2.0 / CC BY 4.0 互換](https://www.digital.go.jp/resources/procedures-survey-results)）
- **免責事項**: 本 MCP サービスおよびサンプルデータは技術検証を目的として提供されており、出力結果は政府の公式見解ではありません。
