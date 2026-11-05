// ゲーム全体の定数（数値はすべて仮値。企画書 2.3 / 3.1 参照）
export const SAVE_VERSION = 2;
export const GAME_VERSION = '0.7.0';
export const CHANGELOG = [
  ['0.7.0', 'プレイテストを受けた改善：セーブの保護と自動修復、掘った跡の色と「気配」、ちりモン入り包装の警告、最後の端数パック、計量機へ全方向から搬入、電力不足でラインが止まらない、スマホのピンチ誤設置の修正'],
  ['0.6.0', '公開版の仕上げ：目標の矢印、初めてのちりモンに出会える配置、山の処理完了画面、エラー時の保護、ホーム画面に追加'],
  ['0.5.0', 'スマホ・セーブ：セーブの二重化と復元、書き出し／読み込み、スマホ操作と画質の詳細設定'],
  ['0.4.0', '工場設計：電力（受電盤・発電機・電柱）、選別機、占有マス・通路'],
  ['0.3.0', '物流：コンベア・ホッパー・包装機・クレーン、建設画面'],
  ['0.2.0', 'ちりモン収集・図鑑、1,000万匹の山'],
];

// 山の個体数（企画書 4.1：1,000万匹がそれぞれ固有IDを持つ）
export const TOTAL_FISH = 10_000_000;

// 山の形状（ゲーム上の寸法・メートル）
export const PILE = {
  cx: -6.0,      // 山の中心X
  cz: 0.0,       // 山の中心Z
  radius: 3.6,   // 裾野の半径
  height: 2.1,   // 頂上の高さ
  cell: 0.1,     // チャンク（柱）1マスの一辺
};

export const FISH_LENGTH = 0.055;      // しらす1匹の見た目の長さ
export const EXPOSE_DEPTH = 0.012;     // 表面からこの深さまでが「露出」
export const REACH = 2.4;              // 手が届く距離
export const EYE_HEIGHT = 1.6;
export const PLAYER_RADIUS = 0.3;
export const PILE_BLOCK_HEIGHT = 0.28; // これより高い山の柱には踏み込めない

// 計量・包装・出荷
export const PACK_SIZE = 20;           // 1パック = 20匹相当
export const PACK_PRICE = 20;          // 1パック = 20円
export const GRAM_PER_FISH = 0.2;      // 1匹 = 0.2g 換算

// 道具・設備の購入品（P0〜P2 では手袋系＋スコップを先行実装）
export const UPGRADES = [
  { id: 'glove1', name: '手袋', desc: '一度につまめる数が 4匹 になる。', price: 15, cap: 4 },
  { id: 'glove2', name: '軍手', desc: '一度につまめる数が 8匹 になる。', price: 60, cap: 8, requires: 'glove1' },
  { id: 'autopack', name: '自動包装スイッチ', desc: '計量機が規定量に達すると自動で包装・出荷する。', price: 150 },
  { id: 'glove3', name: 'ゴム手袋', desc: '一度につまめる数が 20匹 になる。', price: 250, cap: 20, requires: 'glove2' },
  { id: 'boots', name: '長靴', desc: '移動速度が 35% 上がる。', price: 80 },
  { id: 'loupe', name: 'ルーペ', desc: '近くで露出しているちりモンがキラリと光るようになる。', price: 600 },
  { id: 'glove4', name: '作業グローブ', desc: '一度につまめる数が 50匹 になる。', price: 1200, cap: 50, requires: 'glove3' },
  { id: 'scoop', name: 'スコップ', desc: '道具「スコップ」を解放。山の表面を 200匹 まとめてすくう（ちりモンも混ざる）。', price: 4000, scoopCap: 200, requires: 'glove2' },
  { id: 'bigscoop', name: '大スコップ', desc: 'スコップで一度に 600匹 すくえる。', price: 20000, scoopCap: 600, requires: 'scoop' },
  { id: 'box', name: '運搬箱', desc: 'スコップで何度もすくって箱にためられる（最大 1,000匹）。', price: 1500, holdCap: 1000, requires: 'scoop' },
  { id: 'cart', name: '台車', desc: '台車に箱を載せて運ぶ（最大 3,000匹）。', price: 8000, holdCap: 3000, requires: 'box' },
];

// ===== P3：搬送設備 =====
// 建設グリッド（作業場の床を 0.5m 四方のマスで管理）
export const GRID = { cell: 0.5 };

// size: [幅, 奥行き（向きの方向）]。generator は向きに関係なく 2×2。
// power: 消費電力(kW)。prio: 電力不足時の優先度（2=高 1=中 0=低）
export const MACHINES = {
  conveyor: {
    name: 'コンベア', price: 40, blocks: false, size: [1, 1], power: 0.1, prio: 2,
    desc: '向きの方向へしらすを運ぶ。正面からは受け取らない。ドラッグで連続設置。',
  },
  hopper: {
    name: 'ホッパー', price: 600, blocks: true, size: [1, 1], power: 0.5, prio: 2, capacity: 2000,
    desc: '投入口（上・どの向きからでも入る）。向きの方向のベルトへ少しずつ送り出す。',
  },
  packer: {
    name: '包装機', price: 2500, blocks: true, size: [1, 2], power: 1.5, prio: 1, capacity: 400,
    desc: '1×2マス。後ろの面から受け取り20匹ずつ包装・出荷。正面の出荷口マスは空けておく必要がある。',
  },
  crane: {
    name: 'クレーン', price: 15000, blocks: true, size: [1, 1], power: 5, prio: 0, reach: 2.2, grab: 150, cycle: 4.0,
    desc: '山の近くに設置。可動範囲（半径2.2m）の一番高い所をつかみ、向きの方向のホッパー／ベルトへ降ろす。',
  },
  sorter: {
    name: '選別機', price: 9000, blocks: true, size: [1, 1], power: 2, prio: 2, capacity: 200, bin: 12, detect: 0.85, interval: 0.4,
    desc: 'ライン途中に置く。後ろから受け取り、ちりモンを検出率85%で回収箱へ分け、しらすは前へ流す。処理は少し遅い。',
  },
  generator: {
    name: '発電機', price: 20000, blocks: true, size: [2, 2], output: 12, coverage: 3.5, link: 5, fuelCost: 0.06,
    desc: '2×2マス。周囲1マスは通路として空ける。半径3.5mへ12kWを供給。燃料費は負荷1kWあたり0.06円/秒。',
  },
  pole: {
    name: '電柱', price: 300, blocks: false, size: [1, 1], coverage: 3, link: 5,
    desc: '電線で電力を延ばす。5m以内の電柱・発電機・受電盤とつながり、半径3mに配電する。',
  },
};

// 作業場に最初からある受電盤（小さいが無料）
export const POWER_PANEL = { x: 1.0, z: -8.55, output: 3, coverage: 5, link: 5 };

export const BELT = {
  speed: 1.5,        // マス/秒
  spacing: 0.34,     // バッチ同士の間隔（マス）
  hopperBatch: 60,   // ホッパーが一度に送り出す匹数
  hopperInterval: 0.35,
  packInterval: 0.25,
};

export const PRIO_NAMES = ['低', '中', '高'];

// 作業場レイアウト（企画書 2.1）
export const ROOM = { minX: -12, maxX: 12, minZ: -9, maxZ: 9, height: 4.2 };
export const LAYOUT = {
  spawn: { x: 1.2, z: 1.0, yaw: Math.PI / 2 },   // 山の方を向く
  scale: { x: 4.2, z: -1.6 },                     // 計量機
  shelf: { x: 7.0, z: -1.6 },                     // 完成パック集積場所
  case: { x: 1.6, z: 5.6 },                       // 保護ケース
  terminal: { x: 8.6, z: 5.2 },                   // 購入端末
  freeFloor: { minX: 2.5, maxX: 11, minZ: -8.2, maxZ: -4.4 }, // 拡張可能な空き床
};
