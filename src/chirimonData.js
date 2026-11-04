// ちりモン（しらすに混ざる小さな生き物）の種別定義。
// 種別・初期個体数・埋没深度は山の生成時にシードから確定する（企画書 4.3）。
export const SPECIES = [
  {
    id: 'ebi', name: '小エビ', rarity: 1, base: 34, spread: 10, size: 0.032,
    desc: 'くるんと曲がった透明な小エビ。ちりモン界ではいちばんの常連。',
  },
  {
    id: 'kani', name: '小ガニ', rarity: 1, base: 22, spread: 8, size: 0.026,
    desc: '指先ほどのカニ。しらすの山の中でもハサミを構えている。',
  },
  {
    id: 'ika', name: '小イカ', rarity: 2, base: 14, spread: 5, size: 0.036,
    desc: '透きとおった胴体の小さなイカ。光に当てると虹色にきらめく。',
  },
  {
    id: 'tako', name: '小ダコ', rarity: 2, base: 10, spread: 4, size: 0.03,
    desc: '赤い小ダコ。ちりめんモンスターの代名詞的存在。',
  },
  {
    id: 'fugu', name: '小フグ', rarity: 3, base: 6, spread: 3, size: 0.026,
    desc: 'まんまるの稚魚。つままれるとちょっとふくらむ（気がする）。',
  },
  {
    id: 'tatsu', name: 'タツノオトシゴ', rarity: 4, base: 3, spread: 2, size: 0.04,
    desc: '尻尾を巻いた小さなタツノオトシゴ。見つけたら幸運。',
  },
  {
    id: 'nazo', name: 'ナゾの生き物', rarity: 5, base: 1, spread: 1, size: 0.03,
    desc: 'ほのかに青く光る、正体不明の生き物。図鑑の研究者も首をかしげる。',
  },
];

export const SPECIES_BY_ID = Object.fromEntries(SPECIES.map((s, i) => [s.id, { ...s, index: i }]));
