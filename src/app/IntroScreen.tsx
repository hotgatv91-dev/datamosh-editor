import { useEffect, useState } from 'react';
import clsx from 'clsx';
import styles from './intro.module.css';

export function IntroScreen() {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    // Dismiss automatically after 4.5 seconds for dramatic effect
    const timer = setTimeout(() => {
      setVisible(false);
    }, 4500);
    return () => clearTimeout(timer);
  }, []);

  if (!visible) return null;

  return (
    <div className={clsx(styles.introScreen)} onClick={() => setVisible(false)}>
      <div className={styles.staticNoise} />
      <div className={styles.scanlines} />
      <div className={styles.crtVignette} />
      
      <div className={styles.vcrUI}>
        <div className={styles.vcrTop}>
          <span className={styles.playText}>▶ PLAY</span>
          <span className={styles.spText}>SP</span>
        </div>
        <div className={styles.vcrBottom}>
          <span className={styles.dateText}>SEP 26</span>
          <span className={styles.timecode}>00:00:14:08</span>
        </div>
      </div>

      <div className={styles.content}>
        <div className={styles.brandContainer}>
          <div className={styles.brand} data-text="FZ NETWORK">FZ NETWORK</div>
        </div>
        <div className={styles.subtitle}>// ARCHIVE.RECORD.R3P0RT //</div>
        
        <div className={styles.systemText}>
          <div className={styles.warningBox}>
            WARNING: VIEWING COMPROMISED TAPE
          </div>
          <div className={styles.typewriter}>LOADING ABNORMALITY PROTOCOLS...</div>
          <div className={styles.typewriter} style={{ animationDelay: '1s' }}>MOKI.DAT ... FOUND</div>
          <div className={styles.typewriter} style={{ animationDelay: '2.5s', color: 'red' }}>SIGNAL LOST.</div>
        </div>
      </div>
    </div>
  );
}
