import { Component, type ErrorInfo, type ReactNode } from 'react';
import styles from './app.module.css';
import { log } from '../engine/log';
import { t } from '../i18n/strings';

interface State {
  error: Error | null;
  showDetail: boolean;
}

/** The app must never die to a blank page — always show a way forward. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, showDetail: false };

  static getDerivedStateFromError(error: Error): State {
    return { error, showDetail: false };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    log.error('app', 'Unhandled UI error', `${error.message}\n${error.stack ?? ''}\n${info.componentStack}`);
  }

  render(): ReactNode {
    const { error, showDetail } = this.state;
    if (!error) return this.props.children;
    return (
      <div className={styles.crash}>
        <div className={styles.crashTitle}>{t.processingMessage}</div>
        <div className={styles.crashMessage}>{error.message}</div>
        <div className={styles.crashActions}>
          <button type="button" className={styles.crashBtn} onClick={() => this.setState({ showDetail: !showDetail })}>
            {t.details}
          </button>
          <button
            type="button"
            className={styles.crashBtn}
            onClick={() => window.location.reload()}
          >
            Reload editor
          </button>
        </div>
        {showDetail ? <pre className={styles.crashDetail}>{log.asText()}</pre> : null}
      </div>
    );
  }
}
