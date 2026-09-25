import { useEffect, useState } from 'react';
import clsx from 'clsx';
import styles from './intro.module.css';

export function IntroScreen() {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    // Dismiss automatically after 4 seconds
    const timer = setTimeout(() => {
      setVisible(false);
    }, 4000);
    return () => clearTimeout(timer);
  }, []);

  if (!visible) return null;

  return (
    <div className={clsx(styles.introScreen)} onClick={() => setVisible(false)}>
      <div className={styles.staticNoise} />
      <div className={styles.scanlines} />
      <div className={styles.crtVignette} />
      
      <div className={styles.content}>
        <div className={styles.brand}>FZtechnology</div>
        <div className={styles.subtitle}>FZnetwork presents</div>
        
        <div className={styles.systemText}>
          <div className={styles.typewriter}>INITIALIZING SYSTEM_</div>
          <div className={styles.typewriter} style={{ animationDelay: '1s' }}>LOADING PROTOCOLS... OK</div>
          <div className={styles.typewriter} style={{ animationDelay: '2s' }}>AWAITING INPUT</div>
        </div>
      </div>
    </div>
  );
}
