// ゲーム全体の定数（数値はすべて仮値。企画書 2.3 / 3.1 参照）
export const SAVE_VERSION = 1;

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
  { id: 'glove1', name: '手袋', desc: '一度につまめる数が 3匹 になる。', price: 15, cap: 3 },
  { id: 'boots', name: '長靴', desc: '移動速度が 35% 上がる。', price: 80 },
  { id: 'glove2', name: '軍手', desc: '一度につまめる数が 8匹 になる。', price: 60, cap: 8, requires: 'glove1' },
  { id: 'autopack', name: '自動包装スイッチ', desc: '計量機が規定量に達すると自動で包装・出荷する。', price: 150 },
  { id: 'glove3', name: 'ゴム手袋', desc: '一度につまめる数が 20匹 になる。', price: 250, cap: 20, requires: 'glove2' },
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

export const MACHINES = {
  conveyor: {
    name: 'コンベア', price: 40, blocks: false,
    desc: '向きの方向へしらすを運ぶ。ドラッグで連続設置。',
  },
  hopper: {
    name: 'ホッパー', price: 600, blocks: true, capacity: 2000,
    desc: '投入口。手やクレーンで入れたしらすを、向きの方向のベルトへ少しずつ送り出す。',
  },
  packer: {
    name: '包装機', price: 2500, blocks: true, capacity: 400,
    desc: '届いたしらすを20匹ずつ自動で包装・出荷する。ちりモンが混ざると誤出荷。',
  },
  crane: {
    name: 'クレーン', price: 15000, blocks: true, reach: 2.2, grab: 150, cycle: 4.0,
    desc: '山の近くに設置。可動範囲（半径2.2m）の一番高い所をつかみ、向きの方向のホッパー／ベルトへ降ろす。',
  },
};

export const BELT = {
  speed: 1.5,        // マス/秒
  spacing: 0.34,     // バッチ同士の間隔（マス）
  hopperBatch: 60,   // ホッパーが一度に送り出す匹数
  hopperInterval: 0.35,
  packInterval: 0.25,
};

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
