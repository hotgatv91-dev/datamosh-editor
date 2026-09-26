/**
 * Left toolbar plus the panel content for the active tool.
 *
 * The toolbar is where a beginner starts: Media → Edit → Effects → Datamosh.
 * Datamosh is visually distinguished everywhere (amber glyph + label), never
 * icon-only.
 */

import { useMemo, useState } from 'react';
import clsx from 'clsx';
import toolbarStyles from './toolbar.module.css';
import sharedStyles from '../inspector/inspector.module.css';
import { useEditor, type ToolId } from '../../state/store';

// The toolbar sheet owns the nav; the inspector sheet owns the shared panel
// content styles. Merging them keeps one class name per concept.
const styles: Record<string, string> = { ...toolbarStyles, ...sharedStyles };
import { DATAMOSH_PRESETS } from '../../engine/datamosh/presets';
import { BASIC_EFFECTS } from '../../engine/effects/registry';
import { formatTimecode } from '../../engine/timeline/math';
import { clipsSorted, effectById } from '../../engine/timeline/derive';
import { t } from '../../i18n/strings';
import { Button, Empty, Panel, RangeField } from '../../ui/primitives';
import { MediaPanel } from '../media/MediaPanel';
import * as ops from '../../engine/timeline/ops';

interface ToolItem {
  id: string;
  label: string;
  glyph: string;
  hint: string;
  mosh?: boolean;
}

interface ToolGroup {
  title: string;
  items: ToolItem[];
}

const TOOL_GROUPS: ToolGroup[] = [
  {
    title: 'MEDIA',
    items: [
      { id: 'media', label: 'Import', glyph: '📁', hint: 'Import và quản lý video' },
    ]
  },
  {
    title: 'EDIT',
    items: [
      { id: 'edit', label: 'Tools', glyph: '✂', hint: 'Trim, split, xoá, duplicate' },
    ]
  },
  {
    title: 'EFFECTS',
    items: [
      { id: 'effects', label: 'Basic FX', glyph: '✦', hint: 'Glitch, RGB split, VHS…' },
      { id: 'datamosh', label: 'Datamosh', glyph: '◈', hint: 'Datamosh thật: motion vector + I-frame', mosh: true },
      { id: 'speed', label: 'Speed', glyph: '⟳', hint: 'Tốc độ phát và time warp' },
    ]
  },
  {
    title: 'ADJUST',
    items: [
      { id: 'adjust', label: 'Color', glyph: '◐', hint: 'Màu sắc, độ sáng, tương phản' },
      { id: 'audio', label: 'Audio', glyph: '◉', hint: 'Volume, mute, fade' },
    ]
  }
];

function getPresetVisual(id: string) {
  // Return different emoji/text art based on the preset ID
  switch (id) {
    case 'classic': return <span style={{ fontSize: 24, filter: 'hue-rotate(90deg)' }}>🌈</span>;
    case 'motion-stretch': return <span style={{ fontSize: 24, letterSpacing: '4px' }}>👉🏻👉🏻</span>;
    case 'motion-smear': return <span style={{ fontSize: 24, filter: 'blur(2px)' }}>🌪️</span>;
    case 'slow-motion': return <span style={{ fontSize: 24 }}>🐌</span>;
    case 'frame-hold': return <span style={{ fontSize: 24 }}>⏸️</span>;
    case 'frame-repeat': return <span style={{ fontSize: 24 }}>🔁</span>;
    case 'frame-skip': return <span style={{ fontSize: 24, letterSpacing: '8px' }}>⚡️⚡️</span>;
    case 'frame-melt': return <span style={{ fontSize: 24, filter: 'drop-shadow(0 4px 4px var(--mosh))' }}>🫠</span>;
    case 'freeze-warp': return <span style={{ fontSize: 24, transform: 'skewX(20deg)' }}>🧊</span>;
    case 'extreme': return <span style={{ fontSize: 24 }}>💥</span>;
    case 'vhs-drag': return <span style={{ fontSize: 24 }}>📼</span>;
    case 'tape-stutter': return <span style={{ fontSize: 24 }}>📺</span>;
    case 'analog-melt': return <span style={{ fontSize: 24 }}>🔥</span>;
    case 'monster-attack': return <span style={{ fontSize: 24 }}>🦖</span>;
    case 'face-distortion': return <span style={{ fontSize: 24 }}>👽</span>;
    case 'color-bloom': return <span style={{ fontSize: 24, filter: 'saturate(3)' }}>🌺</span>;
    case 'liquid-melt': return <span style={{ fontSize: 24 }}>💧</span>;
    case 'aggressive-stutter': return <span style={{ fontSize: 24, animation: 'shake 0.5s infinite' }}>💢</span>;
    case 'pixel-burst': return <span style={{ fontSize: 24 }}>👾</span>;
    case 'custom': return <span style={{ fontSize: 24 }}>⚙️</span>;
    default: return <span style={{ fontSize: 24 }}>✨</span>;
  }
}

/**
 * The tool rail. Collapsed it keeps the glyphs and drops the labels, so the
 * column can shrink to an icon strip and give the width back to the preview.
 */
export function ToolBar({ vertical = true }: { vertical?: boolean }) {
  const tool = useEditor((s) => s.ui.tool);
  const collapsed = useEditor((s) => s.ui.leftCollapsed);
  const sheet = useEditor((s) => s.ui.sheet);
  const setUi = useEditor((s) => s.setUi);

  if (!vertical) {
    return (
      <div className={styles.mobileTools}>
        {TOOL_GROUPS.flatMap(g => g.items).map((item) => (
          <button
            key={item.id}
            type="button"
            className={clsx(
              styles.mobileTool,
              tool === item.id && styles.mobileToolActive,
              item.mosh && styles.mobileToolMosh,
            )}
            onClick={() => {
              const active = tool === item.id && sheet === item.id;
              setUi({ tool: item.id as ToolId, sheet: active ? null : item.id as any, sheetPeek: false });
            }}
            title={item.hint}
          >
            {item.glyph} {item.label}
          </button>
        ))}
      </div>
    );
  }

  return (
    <nav className={styles.tools}>
      {TOOL_GROUPS.map((group) => (
        <div key={group.title} className={styles.toolGroup}>
          {!collapsed && <div className={styles.toolGroupTitle}>{group.title}</div>}
          {group.items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={clsx(
                styles.tool,
                collapsed && styles.toolCollapsed,
                tool === item.id && styles.toolActive,
                item.mosh && styles.toolMosh,
              )}
              onClick={() => setUi({ tool: item.id as ToolId })}
              title={`${item.label} — ${item.hint}`}
            >
              <span className={styles.toolGlyph}>{item.glyph}</span>
              {collapsed ? null : <span className={styles.toolLabel}>{item.label}</span>}
            </button>
          ))}
        </div>
      ))}
    </nav>
  );
}

export function ToolPanel() {
  const tool = useEditor((s) => s.ui.tool);
  switch (tool) {
    case 'media':
      return <MediaPanel />;
    case 'edit':
      return <EditPanel />;
    case 'effects':
      return <EffectsPanel />;
    case 'datamosh':
      return <DatamoshToolPanel />;
    case 'speed':
      return <SpeedPanel />;
    case 'adjust':
      return <AdjustPanel />;
    case 'audio':
      return <AudioPanel />;
    default:
      return null;
  }
}

/* ------------------------------------------------------------ edit panel */

function EditPanel() {
  const project = useEditor((s) => s.project);
  const playhead = useEditor((s) => s.playhead);
  const selection = useEditor((s) => s.selection);
  const mutate = useEditor((s) => s.mutate);
  const setSelection = useEditor((s) => s.setSelection);
  const clips = clipsSorted(project);
  const clip = clips.find((c) => c.id === selection.clipId) ?? clips[0] ?? null;

  if (!clip) return <Empty title={t.timelineEmpty} hint={t.importVideo} />;

  return (
    <>
      <Panel title={t.edit}>
        <div className={styles.btnGrid}>
          <Button onClick={() => mutate(t.splitAtPlayhead, (draft) => ops.splitClip(draft, clip.id, playhead))}>
            {t.splitAtPlayhead}
          </Button>
          <Button onClick={() => mutate(t.duplicate, (draft) => ops.duplicateClip(draft, clip.id))}>
            {t.duplicate}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              mutate(t.delete, (draft) => ops.deleteClip(draft, clip.id));
              setSelection({ clipId: null });
            }}
          >
            {t.delete}
          </Button>
          <Button onClick={() => setSelection({ clipId: clip.id })}>Select</Button>
        </div>
        <div className={styles.note}>
          Kéo thân clip trên timeline để di chuyển, kéo hai đầu để trim. Playhead đang ở{' '}
          {formatTimecode(playhead, project.fps)}.
        </div>
      </Panel>
      <Panel title="Clip">
        <div className={styles.kv}>
          <span>start</span>
          <span>{clip.startFrame}f</span>
          <span>source in</span>
          <span>{clip.inFrame}f</span>
          <span>source out</span>
          <span>{clip.outFrame}f</span>
          <span>speed</span>
          <span>{clip.speed}×</span>
        </div>
      </Panel>
    </>
  );
}

/* --------------------------------------------------------- effects panel */

function EffectsPanel() {
  const selection = useEditor((s) => s.selection);
  const createEffectRegion = useEditor((s) => s.createEffectRegion);
  const setUi = useEditor((s) => s.setUi);
  const mutate = useEditor((s) => s.mutate);
  const setSelection = useEditor((s) => s.setSelection);

  const range = selection.range;
  /** No marked region is fine — the store makes one around the playhead. */
  const apply = (type: (typeof BASIC_EFFECTS)[number]['type']) => {
    createEffectRegion(type, range);
    // The block was just created on the timeline, so on a phone the sheet drops
    // to a strip: the new block is visible and draggable straight away.
    setUi({ pendingApply: false, tool: 'effects', sheetPeek: true });
  };

  return (
    <>
      <Panel title={t.effects}>
        <div className={clsx(styles.rangeInfo, !range && styles.rangeInfoEmpty)}>
          {range
            ? `Vùng đã đánh dấu ${range.start} → ${range.end} (${Math.abs(range.end - range.start)}f)`
            : `Sẽ tạo block ${Math.round(useEditor.getState().project.fps || 30)}f quanh playhead`}
        </div>
        <div className={styles.fxGrid}>
          {BASIC_EFFECTS.map((effect) => (
            <button
              key={effect.type}
              type="button"
              className={styles.fxItem}
              onClick={() => apply(effect.type)}
              title={effect.description}
            >
              <span className={styles.fxGlyph}>{effect.glyph}</span>
              <span>{effect.label}</span>
            </button>
          ))}
        </div>
        <div className={styles.note}>
          Effect phụ (màu sắc / hình học), tạo thành block ở dải FX bên dưới timeline. Datamosh nằm ở
          công cụ ⚡ Datamosh và dùng dữ liệu chuyển động thật.
        </div>
      </Panel>
      {selection.effectId ? (
        <Panel title="Selected effect">
          <Button
            variant="danger"
            onClick={() => {
              mutate(t.delete, (draft) => ops.deleteEffect(draft, selection.effectId!));
              setSelection({ effectId: null });
            }}
          >
            {t.deleteSelected}
          </Button>
        </Panel>
      ) : null}
    </>
  );
}

/* -------------------------------------------------------- datamosh panel */

function DatamoshToolPanel() {
  const project = useEditor((s) => s.project);
  const selection = useEditor((s) => s.selection);
  const createDatamoshRegion = useEditor((s) => s.createDatamoshRegion);
  const setUi = useEditor((s) => s.setUi);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const setSelection = useEditor((s) => s.setSelection);
  const [activePreset, setActivePreset] = useState('classic');
  const customPresets = useEditor((s) => s.customPresets);

  const range = selection.range;
  const moshEffects = project.effects.filter((e) => e.type === 'datamosh');
  // Saved presets sit alongside the built-ins: applying one has to be as quick
  // as applying Classic, otherwise saving it would not be worth the click.
  const allPresets = [...DATAMOSH_PRESETS, ...customPresets];
  const preset = allPresets.find((p) => p.id === activePreset) ?? DATAMOSH_PRESETS[0]!;

  const apply = () => {
    const id = createDatamoshRegion(preset, range);
    // Fold the sheet to a strip so the block that was just created is on screen
    // and ready to drag — adjusting it is the next step, not opening menus.
    setUi({ pendingApply: false, sheetPeek: true });
    if (!id) return;
    // The new block is selected and the playhead sits on its start, so dragging
    // it into place is the next thing that happens — no I/O marking in between.
    const created = useEditor.getState().project.effects.find((e) => e.id === id);
    if (created) setPlayhead(created.startFrame);
    setSelection({ effectId: id, range: null });
  };

  return (
    <>
      <Panel title={`⚡ ${t.datamosh}`}>
        <div className={clsx(styles.rangeInfo, !range && styles.rangeInfoEmpty)}>
          {range
            ? `Vùng đã đánh dấu ${range.start} → ${range.end} (${Math.abs(range.end - range.start)}f)`
            : `Sẽ tạo block ${Math.round(useEditor.getState().project.fps || 30)}f quanh playhead`}
        </div>
        <div className={styles.presetGrid}>
          {allPresets.map((item) => (
            <button
              key={item.id}
              type="button"
              className={clsx(styles.preset, item.id === activePreset && styles.presetActive)}
              onClick={() => setActivePreset(item.id)}
              title={item.description}
            >
              <div className={styles.presetVisual}>
                {getPresetVisual(item.id)}
              </div>
              <div className={styles.presetLabel}>{item.label}</div>
            </button>
          ))}
        </div>
        <div className={styles.presetDesc}>{preset.description}</div>
        <Button variant="mosh" onClick={apply} className={styles.wide}>
          {t.apply} datamosh
        </Button>
        <div className={styles.note}>
          Bấm là có block ngay: nếu chưa đánh dấu vùng, block ~1 giây quanh playhead được tạo ở dải
          FX bên dưới. Kéo thân block để dời, kéo hai đầu để đổi thời lượng — vùng datamosh chính là
          block đó.
        </div>
      </Panel>

      <Panel title={`${t.datamosh} (${moshEffects.length})`}>
        {moshEffects.length ? (
          moshEffects.map((effect) => (
            <button
              key={effect.id}
              type="button"
              className={clsx(styles.regionItem, selection.effectId === effect.id && styles.regionItemActive)}
              onClick={() => {
                setSelection({ effectId: effect.id, range: null });
                setPlayhead(effect.startFrame);
              }}
            >
              <span>⚡ {effect.preset ?? 'custom'}</span>
              <span className={styles.regionTime}>
                {formatTimecode(effect.startFrame, project.fps)} →{' '}
                {formatTimecode(effect.endFrame, project.fps)}
              </span>
            </button>
          ))
        ) : (
          <div className={styles.note}>Chưa có vùng datamosh nào.</div>
        )}
      </Panel>
    </>
  );
}

/* ------------------------------------------------------------ speed panel */

function SpeedPanel() {
  const project = useEditor((s) => s.project);
  const selection = useEditor((s) => s.selection);
  const mutate = useEditor((s) => s.mutate);
  const clips = clipsSorted(project);
  const clip = clips.find((c) => c.id === selection.clipId) ?? clips[0] ?? null;
  const effect = effectById(project, selection.effectId);

  if (!clip) return <Empty title={t.timelineEmpty} hint={t.importVideo} />;

  return (
    <>
      <Panel title={t.speed}>
        <RangeField
          label="Clip speed"
          value={clip.speed}
          min={0.05}
          max={4}
          step={0.05}
          unit="×"
          hint="Tốc độ của toàn bộ clip."
          onChange={(value) => mutate('Clip speed', (draft) => ops.setClipSpeed(draft, clip.id, value), `speed-clip-${clip.id}`)}
        />
        <div className={styles.note}>
          Datamosh Slow Motion nằm trong block datamosh: chọn block trên timeline rồi chỉnh Speed
          hoặc Speed curve. Đó là chuyển động chậm có frame hold/repeat và biến dạng.
        </div>
      </Panel>
      {effect && effect.type === 'datamosh' ? (
        <Panel title="Selected datamosh">
          <div className={styles.note}>
            Chọn block trên timeline rồi chỉnh Speed và Speed curve ở Inspector bên phải.
          </div>
        </Panel>
      ) : null}
    </>
  );
}

/* ---------------------------------------------------------- adjust panel */

function AdjustPanel() {
  const project = useEditor((s) => s.project);
  const selection = useEditor((s) => s.selection);
  const mutate = useEditor((s) => s.mutate);
  const clips = clipsSorted(project);
  const clip = clips.find((c) => c.id === selection.clipId) ?? clips[0] ?? null;
  if (!clip) return <Empty title={t.timelineEmpty} hint={t.importVideo} />;

  const set = (patch: Record<string, number>) =>
    mutate('Adjust clip', (draft) => ops.setClipAdjust(draft, clip.id, patch), `adjust-${clip.id}`);

  return (
    <Panel title={t.adjust}>
      <RangeField label="Brightness" value={clip.adjust.brightness} min={-100} max={100} onChange={(v) => set({ brightness: v })} />
      <RangeField label="Contrast" value={clip.adjust.contrast} min={-100} max={100} onChange={(v) => set({ contrast: v })} />
      <RangeField label="Saturation" value={clip.adjust.saturation} min={-100} max={100} onChange={(v) => set({ saturation: v })} />
      <RangeField label="Exposure" value={clip.adjust.exposure} min={-100} max={100} onChange={(v) => set({ exposure: v })} />
      <RangeField label="Blur" value={clip.adjust.blur} min={0} max={40} step={0.5} onChange={(v) => set({ blur: v })} />
    </Panel>
  );
}

/* ----------------------------------------------------------- audio panel */

function AudioPanel() {
  const project = useEditor((s) => s.project);
  const selection = useEditor((s) => s.selection);
  const mutate = useEditor((s) => s.mutate);
  const clips = clipsSorted(project);
  const clip = clips.find((c) => c.id === selection.clipId) ?? clips[0] ?? null;
  const asset = useMemo(() => project.media.find((m) => m.id === clip?.mediaId), [project.media, clip?.mediaId]);
  if (!clip) return <Empty title={t.timelineEmpty} hint={t.importVideo} />;

  return (
    <Panel title={t.audio}>
      {!asset?.hasAudio ? <div className={styles.note}>Video này không có track âm thanh.</div> : null}
      <RangeField
        label="Volume"
        value={Math.round(clip.volume * 100)}
        min={0}
        max={200}
        unit="%"
        onChange={(v) => mutate('Volume', (draft) => ops.setClipPatch(draft, clip.id, { volume: v / 100 }), `vol-${clip.id}`)}
      />
      <Button
        variant={clip.muted ? 'mosh' : 'default'}
        onClick={() => mutate('Mute', (draft) => ops.setClipPatch(draft, clip.id, { muted: !clip.muted }))}
      >
        {clip.muted ? 'Unmute' : 'Mute'}
      </Button>
      <div className={styles.note}>
        Audio ở mức clip (volume / mute / fade) — không phải audio editor. Tiếng gốc luôn được giữ
        trong bản xuất; vùng datamosh làm méo tiếng theo nhịp của nó (chỉnh ở Inspector của block).
      </div>
    </Panel>
  );
}
