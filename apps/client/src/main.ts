import './style.css';
import { createGame } from './game/game.ts';

const container = document.querySelector<HTMLElement>('#app')!;
const game = createGame(container);
game.start();

if (import.meta.hot) {
  import.meta.hot.dispose(() => game.stop());
}
