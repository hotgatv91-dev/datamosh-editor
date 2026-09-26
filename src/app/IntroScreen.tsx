import { useState } from 'react';
import clsx from 'clsx';
import styles from './intro.module.css';

export function IntroScreen() {
  const [visible, setVisible] = useState(true);
  const [started, setStarted] = useState(false);

  const handleStart = () => {
    setStarted(true);
    // Give it a brief glitch out before unmounting
    setTimeout(() => {
      setVisible(false);
    }, 400);
  };

  if (!visible) return null;

  return (
    <div className={clsx(styles.introScreen, started && styles.glitchOut)}>
      <div className={styles.staticNoise} />
      <div className={styles.scanlines} />
      <div className={styles.crtVignette} />
      
      <div className={styles.vcrUI}>
        <div className={styles.vcrTop}>
          <span />
          <span className={styles.recText}>REC</span>
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
        <div className={styles.subtitle}>// ARCHIVE.RECORD.SYSTEM //</div>
        
        <div className={styles.systemText}>
          <div className={styles.warningBox}>
            WARNING: VIEWING COMPROMISED TAPE
          </div>
          <div className={styles.typewriter}>INITIALIZING ARCHIVE SYSTEM...</div>
        </div>

        <button className={styles.startBtn} onClick={handleStart}>
          INITIATE SYSTEM
        </button>
      </div>
    </div>
  );
}
