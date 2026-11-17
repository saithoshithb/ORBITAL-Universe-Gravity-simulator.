import { createRoot } from 'react-dom/client';
import { Panel } from './Panel';
import { loadPreset } from './sim';
import { Viewport } from './Viewport';
import './style.css';

loadPreset(0);
createRoot(document.getElementById('root')!).render(
  <>
    <Viewport />
    <Panel />
  </>,
);
