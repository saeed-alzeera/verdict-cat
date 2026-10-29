import Phaser from 'phaser';
import '@fontsource/press-start-2p/index.css';
import './ui/styles.css';
import { BootScene } from './scenes/BootScene';
import { MenuScene } from './scenes/MenuScene';
import { GameScene } from './scenes/GameScene';
import { initUI } from './ui/ui';
import './debug';

function start() {
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    backgroundColor: '#07050c',
    scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth, height: window.innerHeight },
    render: { pixelArt: true, antialias: false, roundPixels: true, powerPreference: 'high-performance' },
    fps: { target: 60, smoothStep: true },
    scene: [BootScene, MenuScene, GameScene],
    input: { keyboard: { capture: [Phaser.Input.Keyboard.KeyCodes.TAB, Phaser.Input.Keyboard.KeyCodes.SPACE] } },
  });
  initUI(game);
  (window as unknown as { __SA_GAME: Phaser.Game }).__SA_GAME = game;
}

// Make sure the pixel font is ready before any canvas text is drawn.
const fonts = document.fonts;
if (fonts && fonts.load) {
  Promise.race([fonts.load('10px "Press Start 2P"'), new Promise((r) => setTimeout(r, 1500))]).then(start, start);
} else start();
