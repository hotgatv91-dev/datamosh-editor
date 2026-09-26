/**
 * Inspector: shows the *selected* effect (or the selected clip) and nothing else.
 *
 * Datamosh gets an easy mode first — preset + Intensity/Motion/Stretch/Speed —
 * with the preset's own controls underneath. I-frame / GOP / motion-vector
 * parameters live behind Advanced Settings, collapsed by default.
 *
 * Only the first few preset-specific controls are shown: a preset that exposes
 * ten sliders at once reads as noise, so the rest wait behind "show more".
 */

/** How many preset-specific sliders are visible before "show more". */
const VISIBLE_PRESET_PARAMS = 3;
/** Always visible for datamosh; never repeated by the detail list. */
const CORE_PARAM_IDS = ['intensity', 'motion', 'stretch', 'speed'];

import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import styles from './inspector.module.css';
import { useEditor } from '../../state/store';
import type { Clip, Effect, Keyframe, ParamBag } from '../../engine/project/types';
import {
  DATAMOSH_PRESETS,
  materializeKeyframes,
  parametersFromBundles,
  presetById,
  type PresetKeyframeSpec,
} from '../../engine/datamosh/presets';
import type { CustomPreset } from '../../engine/datamosh/customPresets';
import { PARAM_MAP, numParam, strParam } from '../../engine/datamosh/params';
import { hasKeyframeAt, resolveParams } from '../../engine/datamosh/keyframes';
import { basicEffectDef } from '../../engine/effects/registry';
import { effectById, assetForClip } from '../../engine/timeline/derive';
import { formatFps, formatResolution, t } from '../../i18n/strings';
import { formatTimecode } from '../../engine/timeline/math';
import * as ops from '../../engine/timeline/ops';
import {
  Button,
  Empty,
  Panel,
  ProgressBar,
  RangeField,
  SelectField,
  ToggleField,
  NumberField,
} from '../../ui/primitives';
import { ExportPanel } from '../export/ExportPanel';

export function Inspector() {
  const project = useEditor((s) => s.project);
  const selection = useEditor((s) => s.selection);
  const effect = effectById(project, selection.effectId);
  const clip = useMemo(
    () => project.clips.find((c) => c.id === selection.clipId) ?? null,
    [project.clips, selection.clipId],
  );

  if (effect) return <EffectInspector effect={effect} />;
  if (clip) return <ClipInspector clip={clip} />;
  return (
    <div className={styles.inspector}>
      <div className={styles.head}>
        <span className={styles.headTitle}>{t.inspector}</span>
      </div>
      <div className={styles.emptyInspector}>
        <div className={styles.emptyIcon}>
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
            <line x1="3" y1="9" x2="21" y2="9"></line>
            <line x1="9" y1="21" x2="9" y2="9"></line>
          </svg>
        </div>
        <div className={styles.emptyTitle}>{t.noEffectSelected}</div>
        <div className={styles.emptyHint}>{t.clickEffectToEdit}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ effect panel */

function EffectInspector({ effect }: { effect: Effect }) {
  const project = useEditor((s) => s.project);
  const playhead = useEditor((s) => s.playhead);
  const mutate = useEditor((s) => s.mutate);
  const setSelection = useEditor((s) => s.setSelection);
  const setUi = useEditor((s) => s.setUi);
  const showAdvanced = useEditor((s) => s.ui.showAdvanced);
  const pendingApply = useEditor((s) => s.ui.pendingApply);

  const customPresets = useEditor((s) => s.customPresets);
  const saveCustomPreset = useEditor((s) => s.saveCustomPreset);
  const deleteCustomPreset = useEditor((s) => s.deleteCustomPreset);
  const [presetName, setPresetName] = useState('');
  const [showAllParams, setShowAllParams] = useState(false);

  const fps = project.fps || 30;
  const params = useMemo(() => resolveParams(effect, playhead), [effect, playhead]);
  const preset = presetById(effect.preset);
  const activeCustom = customPresets.find((item) => item.id === effect.preset) ?? null;
  const isMosh = effect.type === 'datamosh';
  const def = basicEffectDef(effect.type);

  // A new preset resets the disclosure, so the panel always opens compact.
  useEffect(() => setShowAllParams(false), [effect.preset]);

  const setParam = (id: string, value: number | string | boolean) => {
    mutate(
      `Set ${id}`,
      (draft) => ops.setEffectParam(draft, effect.id, id, value),
      `fx-param-${effect.id}-${id}`,
    );
    setUi({ pendingApply: true });
  };

  /**
   * Applies a parameter bundle + normalised keyframes. Takes the bundle rather
   * than an id so a user-saved preset travels the exact same path.
   */
  const applyPresetBundle = (
    presetId: string,
    bundle: Partial<ParamBag>,
    keyframeSpecs: PresetKeyframeSpec[],
    speedCurve?: Effect['speedCurve'],
  ) => {
    mutate(`Preset ${presetId}`, (draft) => {
      ops.setEffectPreset(draft, effect.id, presetId, parametersFromBundles(bundle));
      const target = draft.effects.find((e) => e.id === effect.id);
      if (!target) return;
      target.keyframes = materializeKeyframes(keyframeSpecs, effect);
      if (speedCurve?.length) {
        target.speedCurve = speedCurve.map((point) => ({ ...point }));
      } else if (presetId === 'slow-motion' && !target.speedCurve.length) {
        target.speedCurve = [
          { at: 0, value: 1 },
          { at: 0.25, value: 0.5 },
          { at: 0.6, value: 0.25 },
          { at: 1, value: 1 },
        ];
      }
    });
    setUi({ pendingApply: true });
  };

  const applyPreset = (presetId: string) => {
    const builtin = presetById(presetId);
    applyPresetBundle(presetId, builtin?.params ?? {}, builtin?.keyframes ?? []);
  };

  const applyCustomPreset = (item: CustomPreset) =>
    applyPresetBundle(item.id, item.params, item.keyframes, item.speedCurve);

  const savePreset = () => {
    const saved = saveCustomPreset(presetName, effect.id);
    if (!saved) return;
    setPresetName('');
    setUi({
      status: { kind: 'success', message: `Đã lưu preset "${saved.label}"`, at: Date.now() },
    });
  };

  const toggleKeyframe = (id: string) => {
    const animated = hasKeyframeAt(effect, id, playhead);
    mutate(
      animated ? `Remove keyframe ${id}` : `Keyframe ${id}`,
      (draft) => {
        if (animated) ops.removeKeyframeAt(draft, effect.id, id, playhead);
        else ops.setKeyframe(draft, effect.id, id, playhead, numParam(params, id, 0));
      },
    );
    setUi({ pendingApply: true });
  };

  const relevantIds = isMosh && preset ? preset.relevant : (def?.controls.map((c) => c.id) ?? []);
  const detailIds = relevantIds.filter((id) => !CORE_PARAM_IDS.includes(id));
  const visibleDetailIds = showAllParams ? detailIds : detailIds.slice(0, VISIBLE_PRESET_PARAMS);
  const hiddenCount = detailIds.length - visibleDetailIds.length;

  return (
    <div className={styles.inspector}>
      <div className={styles.head}>
        <span className={styles.headTitle}>{isMosh ? t.datamosh : t.effectSection}</span>
        <span className={clsx(styles.headKind, isMosh && styles.headKindMosh)}>
          {isMosh ? '⚡ ' : ''}
          {isMosh ? (preset?.label ?? activeCustom?.label ?? 'Custom') : (def?.label ?? effect.type)}
        </span>
      </div>

      {pendingApply ? (
        <div className={styles.pending}>
          <span>Preview changes are live</span>
          <Button variant="mosh" onClick={() => setUi({ pendingApply: false })}>
            {t.apply}
          </Button>
        </div>
      ) : (
        <div className={styles.applied}>{t.applied} — export will use these settings</div>
      )}

      <Panel title={`${t.start} / ${t.end} / ${t.duration}`}>
        <div className={styles.timingRow}>
          <div>
            <div className={styles.timingLabel}>{t.start}</div>
            <div className={styles.timingValue}>{formatTimecode(effect.startFrame, fps)}</div>
          </div>
          <div>
            <div className={styles.timingLabel}>{t.end}</div>
            <div className={styles.timingValue}>{formatTimecode(effect.endFrame, fps)}</div>
          </div>
          <div>
            <div className={styles.timingLabel}>{t.duration}</div>
            <div className={styles.timingValue}>
              {formatTimecode(effect.endFrame - effect.startFrame, fps)}
              <span className={styles.timingFrames}> · {effect.endFrame - effect.startFrame}f</span>
            </div>
          </div>
        </div>
        <div className={styles.rowGap} />
        <NumberField
          label={t.start}
          suffix="frame"
          value={effect.startFrame}
          onCommit={(value) =>
            mutate('Set effect start', (draft) =>
              ops.resizeEffectStart(draft, effect.id, Math.round(value)),
            )
          }
        />
        <NumberField
          label={t.end}
          suffix="frame"
          value={effect.endFrame}
          onCommit={(value) =>
            mutate('Set effect end', (draft) => ops.resizeEffectEnd(draft, effect.id, Math.round(value)))
          }
        />
      </Panel>

      {isMosh ? (
        <>
          <Panel title={t.preset}>
            <div className={styles.presetGrid}>
              {DATAMOSH_PRESETS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={clsx(styles.preset, effect.preset === item.id && styles.presetActive)}
                  onClick={() => applyPreset(item.id)}
                  title={item.description}
                >
                  {item.label}
                </button>
              ))}
            </div>
            {preset ? <div className={styles.presetDesc}>{preset.description}</div> : null}

            {customPresets.length ? (
              <>
                <div className={styles.subhead}>Preset của tôi</div>
                <div className={styles.presetGrid}>
                  {customPresets.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={clsx(
                        styles.preset,
                        styles.presetCustom,
                        effect.preset === item.id && styles.presetActive,
                      )}
                      onClick={() => applyCustomPreset(item)}
                      title={item.description}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </>
            ) : null}

            <div className={styles.presetSave}>
              <input
                className={styles.presetInput}
                value={presetName}
                placeholder="Tên preset mới…"
                maxLength={40}
                onChange={(event) => setPresetName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') savePreset();
                }}
              />
              <Button onClick={savePreset} disabled={!presetName.trim()}>
                {t.savePreset}
              </Button>
            </div>
            {activeCustom ? (
              <Button variant="danger" onClick={() => deleteCustomPreset(activeCustom.id)}>
                Xoá preset “{activeCustom.label}”
              </Button>
            ) : null}
            <div className={styles.hint}>
              Lưu bộ tham số + keyframe của vùng này thành preset dùng lại được cho vùng khác (keyframe
              tự giãn theo độ dài vùng).
            </div>
          </Panel>

          <Panel title={t.basicControls}>
            {['intensity', 'motion', 'stretch', 'speed'].map((id) => {
              const param = PARAM_MAP[id]!;
              return (
                <RangeField
                  key={id}
                  label={param.label}
                  value={numParam(params, id, param.default as number)}
                  min={param.min ?? 0}
                  max={param.max ?? 100}
                  step={param.step ?? 1}
                  unit={param.unit}
                  hint={param.hint}
                  variant="mosh"
                  onChange={(value) => setParam(id, value)}
                  keyframe={{ animated: hasKeyframeAt(effect, id, playhead), onToggle: () => toggleKeyframe(id) }}
                />
              );
            })}
          </Panel>

          <Panel title={t.presetControls}>
            {visibleDetailIds.length ? (
              visibleDetailIds.map((id) =>
                renderParam(id, params, effect, playhead, setParam, toggleKeyframe),
              )
            ) : (
              <div className={styles.note}>
                Preset này chỉ dùng các tham số cơ bản ở trên.
              </div>
            )}
            {hiddenCount > 0 ? (
              <Button variant="ghost" onClick={() => setShowAllParams(true)}>
                Hiện thêm {hiddenCount} tham số
              </Button>
            ) : null}
            {showAllParams && detailIds.length > VISIBLE_PRESET_PARAMS ? (
              <Button variant="ghost" onClick={() => setShowAllParams(false)}>
                Thu gọn tham số
              </Button>
            ) : null}
          </Panel>

          <Panel title={t.audio}>
            {renderParam('audioMangle', params, effect, playhead, setParam, toggleKeyframe)}
            {numParam(params, 'audioAmount', 100) >= 0 ?
              renderParam('audioAmount', params, effect, playhead, setParam, toggleKeyframe)
              : null}
            <div className={styles.hint}>
              Tiếng gốc luôn được giữ trong bản xuất. Vùng datamosh làm méo tiếng theo đúng nhịp của
              nó (hạ cao độ + stutter), nên tiếng “trôi” cùng hình.
            </div>
          </Panel>

          <SpeedCurveEditor effect={effect} />

          <KeyframeList effect={effect} />

          <Panel
            title={t.advancedSettings}
            collapsible
            open={showAdvanced}
            onToggle={() => setUi({ showAdvanced: !showAdvanced })}
          >
            {showAdvanced ? (
              <>
                <div className={styles.advancedNote}>
                  I-frame, P-frame, GOP và motion vector chỉ ảnh hưởng khi export ở chế độ bitstream.
                </div>
                {['blend', 'threshold', 'accelThreshold', 'acceleration', 'swapWeight', 'swapFadeIn', 'swapFadeOut', 'mvPrecision', 'blockSize', 'corruption', 'temporalOffset', 'gopSize', 'iframeDrop', 'bFrames'].map(
                  (id) => renderParam(id, params, effect, playhead, setParam, toggleKeyframe),
                )}
              </>
            ) : (
              <div className={styles.advancedNote}>
                Mặc định đóng. Người mới không cần chạm vào khu vực này.
              </div>
            )}
          </Panel>

          <Panel title={t.renderMode}>
            <SelectField
              label={t.renderMode}
              value={effect.renderMode}
              options={[
                { value: 'bitstream', label: t.renderModeBitstream },
                { value: 'preview-quality', label: t.renderModePreview },
              ]}
              onChange={(value) => {
                mutate('Set render mode', (draft) =>
                  ops.setEffectRenderMode(draft, effect.id, value as Effect['renderMode']),
                );
                setUi({ pendingApply: true });
              }}
              hint={
                effect.renderMode === 'bitstream'
                  ? t.renderModeBitstreamHint
                  : t.renderModePreviewHint
              }
            />
          </Panel>
        </>
      ) : (
        <Panel title={def?.label ?? effect.type}>
          {def ? <div className={styles.presetDesc}>{def.description}</div> : null}
          {def?.controls.map((control) =>
            renderParamControl(control, params, effect, playhead, setParam, toggleKeyframe),
          )}
        </Panel>
      )}

      <Panel title="">
        <div className={styles.actions}>
          <Button
            onClick={() =>
              mutate('Reset effect', (draft) => {
                const target = draft.effects.find((e) => e.id === effect.id);
                if (!target) return;
                const presetId = effect.preset;
                const fresh = presetId ? presetById(presetId) : null;
                const saved = customPresets.find((item) => item.id === presetId) ?? null;
                if (fresh) {
                  ops.setEffectPreset(draft, effect.id, fresh.id, parametersFromBundles(fresh.params));
                  target.keyframes = materializeKeyframes(fresh.keyframes ?? [], effect);
                } else if (saved) {
                  ops.setEffectPreset(draft, effect.id, saved.id, parametersFromBundles(saved.params));
                  target.keyframes = materializeKeyframes(saved.keyframes, effect);
                } else {
                  ops.setEffectParam(draft, effect.id, 'intensity', 60);
                }
              })
            }
          >
            {t.reset}
          </Button>
          <Button
            onClick={() => mutate('Duplicate effect', (draft) => ops.duplicateEffect(draft, effect.id))}
          >
            {t.duplicate}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              mutate('Delete effect', (draft) => ops.deleteEffect(draft, effect.id));
              setSelection({ effectId: null });
            }}
          >
            {t.delete}
          </Button>
          <Button
            variant="ghost"
            onClick={() =>
              mutate('Toggle effect', (draft) => ops.toggleEffectEnabled(draft, effect.id))
            }
          >
            {effect.enabled ? 'Disable' : 'Enable'}
          </Button>
        </div>
      </Panel>
    </div>
  );
}

function renderParam(
  id: string,
  params: ParamBag,
  effect: Effect,
  playhead: number,
  setParam: (id: string, value: number | string | boolean) => void,
  toggleKeyframe: (id: string) => void,
) {
  const param = PARAM_MAP[id];
  if (!param) return null;
  const keyframe = param.animatable
    ? { animated: hasKeyframeAt(effect, id, playhead), onToggle: () => toggleKeyframe(id) }
    : undefined;
  if (param.kind === 'toggle') {
    return (
      <ToggleField
        key={id}
        label={param.label}
        checked={paramBoolean(params, id)}
        onChange={(value) => setParam(id, value)}
        hint={param.hint}
      />
    );
  }
  if (param.kind === 'select') {
    return (
      <SelectField
        key={id}
        label={param.label}
        value={strParam(params, id, String(param.default))}
        options={param.options ?? []}
        onChange={(value) => setParam(id, value)}
        hint={param.hint}
      />
    );
  }
  return (
    <RangeField
      key={id}
      label={param.label}
      value={numParam(params, id, param.default as number)}
      min={param.min ?? 0}
      max={param.max ?? 100}
      step={param.step ?? 1}
      unit={param.unit}
      hint={param.bitstreamOnly ? `${param.hint} (${t.supportsBitstreamOnly})` : param.hint}
      variant={effect.type === 'datamosh' ? 'mosh' : 'default'}
      onChange={(value) => setParam(id, value)}
      keyframe={keyframe}
    />
  );
}

function renderParamControl(
  control: { id: string; label: string; min: number; max: number; step: number; unit?: string },
  params: ParamBag,
  effect: Effect,
  playhead: number,
  setParam: (id: string, value: number | string | boolean) => void,
  toggleKeyframe: (id: string) => void,
) {
  return (
    <RangeField
      key={control.id}
      label={control.label}
      value={numParam(params, control.id, control.min)}
      min={control.min}
      max={control.max}
      step={control.step}
      unit={control.unit}
      variant={effect.type === 'datamosh' ? 'mosh' : 'default'}
      onChange={(value) => setParam(control.id, value)}
      keyframe={{
        animated: hasKeyframeAt(effect, control.id, playhead),
        onToggle: () => toggleKeyframe(control.id),
      }}
    />
  );
}

function paramBoolean(params: ParamBag, id: string): boolean {
  const value = params[id];
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  return false;
}

/* ------------------------------------------------------------ speed curve */

function SpeedCurveEditor({ effect }: { effect: Effect }) {
  const mutate = useEditor((s) => s.mutate);
  const [open, setOpen] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const points = effect.speedCurve.length
    ? effect.speedCurve
    : [
        { at: 0, value: 1 },
        { at: 1, value: 1 },
      ];

  const draw = (highlight: number | null) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = 240;
    const h = 58;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== w * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = '100%';
      canvas.style.height = `${h}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0b0d10';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#232a32';
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    const toY = (value: number) => h - (Math.log(value) / Math.log(4) + 1) * 0.5 * h;
    ctx.strokeStyle = '#ffab1f';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i <= 32; i += 1) {
      const at = i / 32;
      const value = interpolate(points, at);
      const x = at * w;
      const y = toY(value);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    points.forEach((point, index) => {
      ctx.fillStyle = highlight === index ? '#ffffff' : '#ffab1f';
      ctx.beginPath();
      ctx.arc(point.at * w, toY(point.value), highlight === index ? 5 : 4, 0, Math.PI * 2);
      ctx.fill();
    });
  };

  const commit = (next: { at: number; value: number }[]) => {
    mutate('Speed curve', (draft) => ops.setEffectSpeedCurve(draft, effect.id, next), `speed-${effect.id}`);
  };

  return (
    <Panel title={t.speedCurve} collapsible open={open} onToggle={() => setOpen(!open)}>
      {open ? (
        <>
          <canvas
            ref={(node) => {
              canvasRef.current = node;
              if (node) draw(null);
            }}
            className={styles.curve}
            onPointerDown={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const at = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
              const h = 58;
              const y = event.clientY - rect.top;
              const value = Math.min(4, Math.max(0.05, Math.pow(4, (1 - (2 * y) / h))));
              const existing = points.findIndex((p) => Math.abs(p.at - at) < 0.06);
              const next = [...points];
              if (existing >= 0) next[existing] = { at: next[existing]!.at, value: Number(value.toFixed(2)) };
              else next.push({ at, value: Number(value.toFixed(2)) });
              commit(next.sort((a, b) => a.at - b.at));
            }}
          />
          <div className={styles.hint}>{t.speedCurveHint}</div>
          <div className={styles.rowGap} />
          <Button
            variant="ghost"
            onClick={() =>
              commit([
                { at: 0, value: 1 },
                { at: 0.25, value: 0.5 },
                { at: 0.6, value: 0.25 },
                { at: 1, value: 1 },
              ])
            }
          >
            Slow ramp preset
          </Button>
          <Button variant="ghost" onClick={() => commit([{ at: 0, value: 1 }, { at: 1, value: 1 }])}>
            Reset curve
          </Button>
        </>
      ) : (
        <div className={styles.hint}>{t.speedCurveHint}</div>
      )}
    </Panel>
  );
}

function interpolate(points: { at: number; value: number }[], at: number): number {
  const sorted = [...points].sort((a, b) => a.at - b.at);
  if (!sorted.length) return 1;
  const first = sorted[0]!;
  if (at <= first.at) return first.value;
  const last = sorted[sorted.length - 1]!;
  if (at >= last.at) return last.value;
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    if (at >= a.at && at <= b.at) {
      const span = Math.max(1e-4, b.at - a.at);
      return a.value + (b.value - a.value) * ((at - a.at) / span);
    }
  }
  return last.value;
}

/* ------------------------------------------------------------- keyframes */

function KeyframeList({ effect }: { effect: Effect }) {
  const mutate = useEditor((s) => s.mutate);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  if (!effect.keyframes.length) {
    return (
      <Panel title={`${t.keyframes} (0)`}>
        <div className={styles.hint}>
          Bấm ◆ cạnh một thông số để tạo keyframe tại playhead. Ví dụ: 00:04 Intensity 10% → 00:06
          Intensity 100%.
        </div>
      </Panel>
    );
  }
  const grouped = new Map<string, Keyframe[]>();
  for (const key of effect.keyframes) {
    const list = grouped.get(key.param) ?? [];
    list.push(key);
    grouped.set(key.param, list);
  }
  return (
    <Panel
      title={`${t.keyframes} (${effect.keyframes.length})`}
      action={
        <Button
          variant="ghost"
          onClick={() => mutate('Clear keyframes', (draft) => ops.clearEffectKeyframes(draft, effect.id))}
        >
          clear
        </Button>
      }
    >
      {[...grouped.entries()].map(([param, keys]) => (
        <div key={param} className={styles.kfGroup}>
          <div className={styles.kfParam}>{PARAM_MAP[param]?.label ?? param}</div>
          {keys
            .sort((a, b) => a.frame - b.frame)
            .map((key) => (
              <div key={key.id} className={styles.kfRow}>
                <button type="button" className={styles.kfTime} onClick={() => setPlayhead(key.frame)}>
                  {formatTimecode(key.frame, 30)}
                </button>
                <span className={styles.kfValue}>{key.value.toFixed(1)}</span>
                <button
                  type="button"
                  className={styles.kfDelete}
                  onClick={() => mutate('Remove keyframe', (draft) => ops.removeKeyframe(draft, effect.id, key.id))}
                  title="Remove keyframe"
                >
                  ✕
                </button>
              </div>
            ))}
        </div>
      ))}
    </Panel>
  );
}

/* ----------------------------------------------------------- clip panel */

function ClipInspector({ clip }: { clip: Clip }) {
  const project = useEditor((s) => s.project);
  const mutate = useEditor((s) => s.mutate);
  const asset = assetForClip(project, clip);
  const fps = project.fps || 30;

  const setAdjust = (patch: Record<string, number>) =>
    mutate('Adjust clip', (draft) => ops.setClipAdjust(draft, clip.id, patch), `adjust-${clip.id}`);

  const setTransform = (patch: Record<string, unknown>) =>
    mutate('Transform clip', (draft) => ops.setClipTransform(draft, clip.id, patch), `transform-${clip.id}`);

  return (
    <div className={styles.inspector}>
      <div className={styles.head}>
        <span className={styles.headTitle}>{t.clipSection}</span>
        <span className={styles.headKind}>{asset?.name ?? 'clip'}</span>
      </div>

      {asset ? (
        <Panel title={t.properties}>
          <div className={styles.propGrid}>
            <span>{t.resolutionLabel}</span>
            <span>{formatResolution(asset.width, asset.height)}</span>
            <span>{t.fpsLabel}</span>
            <span>{formatFps(asset.fps)}</span>
            <span>{t.duration}</span>
            <span>{formatTimecode(clip.outFrame - clip.inFrame, fps)}</span>
            <span>{t.start}</span>
            <span>{formatTimecode(clip.startFrame, fps)}</span>
            <span>{t.size}</span>
            <span>{(asset.sizeBytes / 1024 ** 2).toFixed(1)} MB</span>
            <span>Codec</span>
            <span>{asset.videoCodec}</span>
          </div>
        </Panel>
      ) : null}

      <Panel title={t.adjust}>
        <RangeField label="Brightness" value={clip.adjust.brightness} min={-100} max={100} onChange={(v) => setAdjust({ brightness: v })} />
        <RangeField label="Contrast" value={clip.adjust.contrast} min={-100} max={100} onChange={(v) => setAdjust({ contrast: v })} />
        <RangeField label="Saturation" value={clip.adjust.saturation} min={-100} max={100} onChange={(v) => setAdjust({ saturation: v })} />
        <RangeField label="Exposure" value={clip.adjust.exposure} min={-100} max={100} onChange={(v) => setAdjust({ exposure: v })} />
        <RangeField label="Blur" value={clip.adjust.blur} min={0} max={40} step={0.5} onChange={(v) => setAdjust({ blur: v })} />
      </Panel>

      <Panel title="Transform">
        <RangeField label="Position X" value={clip.transform.x} min={-100} max={100} onChange={(v) => setTransform({ x: v })} />
        <RangeField label="Position Y" value={clip.transform.y} min={-100} max={100} onChange={(v) => setTransform({ y: v })} />
        <RangeField label="Scale" value={clip.transform.scale} min={0.1} max={4} step={0.05} unit="×" onChange={(v) => setTransform({ scale: v })} />
        <RangeField label="Rotate" value={clip.transform.rotation} min={-180} max={180} step={1} unit="°" onChange={(v) => setTransform({ rotation: v })} />
        <ToggleField label="Flip horizontal" checked={clip.transform.flipH} onChange={(v) => setTransform({ flipH: v })} />
        <ToggleField label="Flip vertical" checked={clip.transform.flipV} onChange={(v) => setTransform({ flipV: v })} />
      </Panel>

      <Panel title={t.speed}>
        <NumberField
          label={t.speed}
          suffix="×"
          step={0.05}
          min={0.05}
          max={8}
          value={clip.speed}
          onCommit={(value) => mutate('Clip speed', (draft) => ops.setClipSpeed(draft, clip.id, value))}
        />
        <div className={styles.hint}>
          Timeline length follows the speed. Dùng Datamosh Slow Motion nếu muốn chuyển động chậm có
          biến dạng theo chuyển động.
        </div>
      </Panel>

      <Panel title={t.audio}>
        <RangeField
          label="Volume"
          value={Math.round(clip.volume * 100)}
          min={0}
          max={200}
          unit="%"
          onChange={(v) => mutate('Volume', (draft) => ops.setClipPatch(draft, clip.id, { volume: v / 100 }), `vol-${clip.id}`)}
        />
        <ToggleField
          label="Mute"
          checked={clip.muted}
          onChange={(v) => mutate('Mute', (draft) => ops.setClipPatch(draft, clip.id, { muted: v }))}
        />
        <NumberField
          label="Fade in"
          suffix="frames"
          value={clip.fadeInFrames}
          min={0}
          onCommit={(v) => mutate('Fade in', (draft) => ops.setClipPatch(draft, clip.id, { fadeInFrames: Math.max(0, Math.round(v)) }))}
        />
        <NumberField
          label="Fade out"
          suffix="frames"
          value={clip.fadeOutFrames}
          min={0}
          onCommit={(v) => mutate('Fade out', (draft) => ops.setClipPatch(draft, clip.id, { fadeOutFrames: Math.max(0, Math.round(v)) }))}
        />
      </Panel>

      <Panel title="Trim">
        <NumberField
          label="Source in"
          suffix="frame"
          value={clip.inFrame}
          onCommit={(v) => mutate('Trim in', (draft) => ops.trimClipToSource(draft, clip.id, v, clip.outFrame))}
        />
        <NumberField
          label="Source out"
          suffix="frame"
          value={clip.outFrame}
          onCommit={(v) => mutate('Trim out', (draft) => ops.trimClipToSource(draft, clip.id, clip.inFrame, v))}
        />
        <Button
          onClick={() => mutate('Split clip', (draft) => ops.splitClip(draft, clip.id, useEditor.getState().playhead))}
        >
          {t.splitAtPlayhead}
        </Button>
      </Panel>

      <Panel title={t.exportTitle}>
        <ExportPanel />
      </Panel>
    </div>
  );
}

export { ProgressBar };
