/** Status toast. Errors always offer the Details panel the spec asks for. */

import { useEffect, useState } from 'react';
import clsx from 'clsx';
import styles from './app.module.css';
import { useEditor } from '../state/store';
import { Button } from '../ui/primitives';
import { t } from '../i18n/strings';
import { log } from '../engine/log';

export function StatusBar() {
  const status = useEditor((s) => s.ui.status);
  const setStatus = useEditor((s) => s.setStatus);
  const [showDetail, setShowDetail] = useState(false);

  useEffect(() => {
    if (!status || status.kind === 'error') return;
    const timer = window.setTimeout(() => setStatus(null), 4500);
    return () => window.clearTimeout(timer);
  }, [status, setStatus]);

  useEffect(() => {
    setShowDetail(false);
  }, [status?.at]);

  if (!status) return null;

  const detail = status.detail ?? log.asText();

  return (
    <div className={clsx(styles.statusWrap, status.kind === 'error' && styles.statusWrapError)}>
      <div className={styles.statusRow}>
        <span
          className={clsx(
            styles.statusDot,
            status.kind === 'error' && styles.statusDotError,
            status.kind === 'success' && styles.statusDotOk,
          )}
        />
        <span className={styles.statusMessage}>{status.message}</span>
        {detail ? (
          <Button variant="ghost" onClick={() => setShowDetail(!showDetail)}>
            {t.details}
          </Button>
        ) : null}
        <Button variant="ghost" onClick={() => setStatus(null)}>
          {t.close}
        </Button>
      </div>
      {showDetail ? (
        <pre className={styles.statusDetail} onClick={(event) => void event}>
          {detail}
        </pre>
      ) : null}
    </div>
  );
}
