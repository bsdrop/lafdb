// player.html 전용 번들 엔트리
// player-ui를 먼저 — rewriteCDN, buildEpUrl 등 글로벌 함수 정의
import './player-ui';
// player-dl은 player-ui 이후 — btn-download 핸들러가 quality-selector 참조
import './player-dl';
// player-init은 마지막 — Worker/Player 초기화, _dlInit 호출
import './player-init';
