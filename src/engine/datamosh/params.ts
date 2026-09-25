/**
 * THE shared datamosh parameter schema.
 *
 * One definition drives three consumers:
 *   1. the UI (Simple mode shows `basic` + the preset's own controls,
 *      Advanced Settings shows `advanced`),
 *   2. the WebGL preview backend,
 *   3. the ffmpeg bitstream backend.
 *
 * The vocabulary deliberately mirrors the motion-vector model of the After
 * Effects "Mosh" plugin (intensity, blend, threshold, acceleration, swap,
 * hold frames, random blocks) because that is what datamosh actually is:
 * motion information being manipulated, not a glitch overlay.
 */

export type ParamGroup = 'basic' | 'preset' | 'advanced';

export interface SelectOption {
  value: string;
  label: string;
}

export interface ParamDef {
  id: string;
  label: string;
  group: ParamGroup;
  kind: 'range' | 'toggle' | 'select';
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: SelectOption[];
  default: number | string | boolean;
  /** Vietnamese one-liner shown under the control. */
  hint: string;
  animatable: boolean;
  /** Only meaningful for the ffmpeg bitstream backend. */
  bitstreamOnly?: boolean;
}

export const PARAMS: ParamDef[] = [
  // ---------------------------------------------------------------- basic
  {
    id: 'intensity',
    label: 'Intensity',
    group: 'basic',
    kind: 'range',
    min: 0,
    max: 200,
    step: 1,
    unit: '%',
    default: 60,
    hint: 'Độ mạnh biến đổi motion vector.',
    animatable: true,
  },
  {
    id: 'motion',
    label: 'Motion',
    group: 'basic',
    kind: 'range',
    min: 0,
    max: 200,
    step: 1,
    unit: '%',
    default: 50,
    hint: 'Mức bám theo chuyển động thật của hình ảnh.',
    animatable: true,
  },
  {
    id: 'stretch',
    label: 'Stretch',
    group: 'basic',
    kind: 'range',
    min: 0,
    max: 200,
    step: 1,
    unit: '%',
    default: 40,
    hint: 'Kéo giãn hình ảnh theo hướng chuyển động.',
    animatable: true,
  },
  {
    id: 'speed',
    label: 'Speed',
    group: 'basic',
    kind: 'range',
    min: 0.05,
    max: 4,
    step: 0.05,
    unit: '×',
    default: 1,
    hint: 'Tốc độ phát riêng trong vùng effect.',
    animatable: true,
  },

  // --------------------------------------------------------------- preset
  {
    id: 'persistence',
    label: 'Motion Persistence',
    group: 'preset',
    kind: 'range',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    default: 45,
    hint: 'Giữ chuyển động của các frame trước lâu hơn.',
    animatable: true,
  },
  {
    id: 'decay',
    label: 'Decay',
    group: 'preset',
    kind: 'range',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    default: 12,
    hint: 'Độ phai dần của phần hình ảnh được giữ lại.',
    animatable: true,
  },
  {
    id: 'smearLength',
    label: 'Smear Length',
    group: 'preset',
    kind: 'range',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    default: 40,
    hint: 'Độ dài vệt kéo theo chuyển động.',
    animatable: true,
  },
  {
    id: 'frameInfluence',
    label: 'Frame Influence',
    group: 'preset',
    kind: 'range',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    default: 45,
    hint: 'Ảnh hưởng của frame trước lên frame hiện tại.',
    animatable: true,
  },
  {
    id: 'holdFrames',
    label: 'Hold Frames',
    group: 'preset',
    kind: 'range',
    min: 0,
    max: 48,
    step: 1,
    unit: 'f',
    default: 0,
    hint: 'Số frame giữ nguyên trước khi nhảy sang frame kế tiếp.',
    animatable: false,
  },
  {
    id: 'repeatCount',
    label: 'Repeat Count',
    group: 'preset',
    kind: 'range',
    min: 1,
    max: 12,
    step: 1,
    unit: '×',
    default: 1,
    hint: 'Số lần lặp lại mỗi frame.',
    animatable: false,
  },
  {
    id: 'repeatInterval',
    label: 'Repeat Interval',
    group: 'preset',
    kind: 'range',
    min: 1,
    max: 24,
    step: 1,
    unit: 'f',
    default: 1,
    hint: 'Cứ bao nhiêu frame thì lặp một lần.',
    animatable: false,
  },
  {
    id: 'skipAmount',
    label: 'Skip Amount',
    group: 'preset',
    kind: 'range',
    min: 0,
    max: 12,
    step: 1,
    unit: 'f',
    default: 0,
    hint: 'Số frame bị bỏ qua mỗi lần.',
    animatable: false,
  },
  {
    id: 'skipPattern',
    label: 'Pattern',
    group: 'preset',
    kind: 'select',
    default: 'regular',
    options: [
      { value: 'regular', label: 'Regular' },
      { value: 'random', label: 'Random' },
      { value: 'burst', label: 'Burst' },
    ],
    hint: 'Kiểu bỏ frame.',
    animatable: false,
  },
  {
    id: 'randomness',
    label: 'Randomness',
    group: 'preset',
    kind: 'range',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    default: 20,
    hint: 'Mức ngẫu nhiên của hiệu ứng.',
    animatable: true,
  },
  {
    id: 'freezeDuration',
    label: 'Freeze Duration',
    group: 'preset',
    kind: 'range',
    min: 0,
    max: 60,
    step: 1,
    unit: 'f',
    default: 0,
    hint: 'Số frame đóng băng hoàn toàn ở đầu vùng effect.',
    animatable: false,
  },
  {
    id: 'transition',
    label: 'Transition',
    group: 'preset',
    kind: 'range',
    min: 0,
    max: 48,
    step: 1,
    unit: 'f',
    default: 6,
    hint: 'Số frame chuyển tiếp vào và ra khỏi hiệu ứng.',
    animatable: false,
  },
  {
    id: 'direction',
    label: 'Direction',
    group: 'preset',
    kind: 'range',
    min: 0,
    max: 360,
    step: 1,
    unit: '°',
    default: 0,
    hint: 'Hướng kéo của motion stretch. 0° = theo chuyển động thật.',
    animatable: true,
  },
  {
    id: 'temporalOffset',
    label: 'Temporal Offset',
    group: 'preset',
    kind: 'range',
    min: 0,
    max: 16,
    step: 1,
    unit: 'f',
    default: 2,
    hint: 'Lệch thời gian giữa ảnh tham chiếu và motion vector.',
    animatable: true,
  },

  // -------------------------------------------------------------- advanced
  {
    id: 'blend',
    label: 'Blend',
    group: 'advanced',
    kind: 'range',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    default: 0,
    hint: 'Trộn giữa motion vector gốc và motion vector đã biến đổi.',
    animatable: true,
  },
  {
    id: 'threshold',
    label: 'Motion Threshold',
    group: 'advanced',
    kind: 'range',
    min: -100,
    max: 100,
    step: 1,
    default: 0,
    hint: 'Chỉ tác động ở nơi chuyển động trên (hoặc dưới, nếu âm) ngưỡng này.',
    animatable: true,
  },
  {
    id: 'accelThreshold',
    label: 'Scale threshold over time',
    group: 'advanced',
    kind: 'toggle',
    default: false,
    hint: 'Ngưỡng tăng dần theo thời gian trong vùng effect.',
    animatable: false,
  },
  {
    id: 'acceleration',
    label: 'Acceleration',
    group: 'advanced',
    kind: 'range',
    min: 0,
    max: 200,
    step: 1,
    unit: '%',
    default: 15,
    hint: 'Độ mạnh tăng dần trong suốt vùng effect.',
    animatable: true,
  },
  {
    id: 'swapWeight',
    label: 'Swap Weight',
    group: 'advanced',
    kind: 'range',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    default: 0,
    hint: 'Trộn sang motion vector của vùng tham chiếu (swap).',
    animatable: true,
  },
  {
    id: 'swapFadeIn',
    label: 'Swap Fade In',
    group: 'advanced',
    kind: 'range',
    min: 0,
    max: 60,
    step: 1,
    unit: 'f',
    default: 6,
    hint: 'Số frame tăng dần trọng số swap ở đầu vùng.',
    animatable: false,
  },
  {
    id: 'swapFadeOut',
    label: 'Swap Fade Out',
    group: 'advanced',
    kind: 'range',
    min: 0,
    max: 60,
    step: 1,
    unit: 'f',
    default: 6,
    hint: 'Số frame giảm dần trọng số swap ở cuối vùng.',
    animatable: false,
  },
  {
    id: 'mvPrecision',
    label: 'Motion Search Radius',
    group: 'advanced',
    kind: 'range',
    min: 1,
    max: 6,
    step: 1,
    unit: 'px',
    default: 3,
    hint: 'Bán kính tìm chuyển động. Cao hơn = chính xác hơn nhưng chậm hơn.',
    animatable: false,
  },
  {
    id: 'blockSize',
    label: 'Block Size',
    group: 'advanced',
    kind: 'select',
    default: '8',
    options: [
      { value: '4', label: '4 px (fine)' },
      { value: '8', label: '8 px (balanced)' },
      { value: '16', label: '16 px (coarse)' },
    ],
    hint: 'Kích thước macroblock khi tính motion vector.',
    animatable: false,
  },
  {
    id: 'corruption',
    label: 'Corruption',
    group: 'advanced',
    kind: 'range',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    default: 0,
    hint: 'Phá dữ liệu theo khối, mô phỏng lỗi giải mã.',
    animatable: true,
  },
  {
    id: 'gopSize',
    label: 'GOP Size',
    group: 'advanced',
    kind: 'range',
    min: 1,
    max: 600,
    step: 1,
    unit: 'f',
    default: 24,
    hint: 'Khoảng cách giữa các I-frame khi chuẩn bị bitstream.',
    animatable: false,
    bitstreamOnly: true,
  },
  {
    id: 'iframeDrop',
    label: 'Remove I-frames',
    group: 'advanced',
    kind: 'toggle',
    default: true,
    hint: 'Gỡ I-frame khỏi bitstream để tạo drift thật khi export.',
    animatable: false,
    bitstreamOnly: true,
  },
  {
    id: 'bFrames',
    label: 'Allow B-frames',
    group: 'advanced',
    kind: 'toggle',
    default: false,
    hint: 'B-frame làm datamosh khó kiểm soát — mặc định tắt.',
    animatable: false,
    bitstreamOnly: true,
  },
  {
    id: 'audioMangle',
    label: 'Méo tiếng theo vùng',
    group: 'advanced',
    kind: 'toggle',
    default: true,
    hint: 'Hạ cao độ và tạo stutter cho tiếng bên trong vùng datamosh, khớp với nhịp của hình.',
    animatable: false,
  },
  {
    id: 'audioAmount',
    label: 'Độ méo tiếng',
    group: 'advanced',
    kind: 'range',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    default: 100,
    hint: '0% = giữ nguyên tiếng gốc, 100% = méo tối đa theo tham số của vùng.',
    animatable: false,
  },
];

export const PARAM_MAP: Record<string, ParamDef> = Object.fromEntries(
  PARAMS.map((p) => [p.id, p]),
);

export function paramDef(id: string): ParamDef | undefined {
  return PARAM_MAP[id];
}

export function paramsByGroup(group: ParamGroup): ParamDef[] {
  return PARAMS.filter((p) => p.group === group);
}

export function numParam(params: Record<string, unknown>, id: string, fallback = 0): number {
  const value = params[id];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  const def = PARAM_MAP[id];
  if (def && typeof def.default === 'number') return def.default;
  return fallback;
}

export function boolParam(params: Record<string, unknown>, id: string, fallback = false): boolean {
  const value = params[id];
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  const def = PARAM_MAP[id];
  if (def && typeof def.default === 'boolean') return def.default;
  return fallback;
}

export function strParam(params: Record<string, unknown>, id: string, fallback = ''): string {
  const value = params[id];
  if (typeof value === 'string') return value;
  const def = PARAM_MAP[id];
  if (def && typeof def.default === 'string') return def.default;
  return fallback;
}

export function defaultParameters(): Record<string, number | string | boolean> {
  const bag: Record<string, number | string | boolean> = {};
  for (const def of PARAMS) bag[def.id] = def.default;
  return bag;
}

export function clampParam(id: string, value: number | string | boolean): number | string | boolean {
  const def = PARAM_MAP[id];
  if (!def) return value;
  if (def.kind === 'range' && typeof value === 'number') {
    const min = def.min ?? 0;
    const max = def.max ?? 1;
    return Math.min(max, Math.max(min, value));
  }
  return value;
}

/** Fills defaults, clamps ranges and drops values that are not numbers/strings/bools. */
export function normalizeParams(
  raw: Record<string, unknown> | undefined,
): Record<string, number | string | boolean> {
  const out = defaultParameters();
  if (!raw) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!PARAM_MAP[key]) continue;
    const type = typeof value;
    if (type !== 'number' && type !== 'string' && type !== 'boolean') continue;
    out[key] = clampParam(key, value as number | string | boolean);
  }
  return out;
}

/** Params that only the bitstream backend can honour. */
export function bitstreamOnlyParamIds(): string[] {
  return PARAMS.filter((p) => p.bitstreamOnly).map((p) => p.id);
}
