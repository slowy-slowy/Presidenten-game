const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ---------- Kaarten & helpers ----------
const SUITS = ['C','D','H','S'];
const RANKS = ['3','4','5','6','7','8','9','10','J','Q','K','A','2'];
const RANK_VAL = Object.fromEntries(RANKS.map((r,i)=>[r,i]));

function newDeck(count=1){
  const d=[];
  for(let k=0;k<count;k++){
    for(const s of SUITS){ for(const r of RANKS){ d.push(r+s); } }
  }
  return shuffle(d);
}
function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [a[i],a[j]]=[a[j],a[i]];} return a; }
function isTwo(c){ return c.slice(0,-1)==='2'; }
function rankOf(c){ return c.slice(0,-1); }
function sortHand(h){
  return h.slice().sort((a,b)=>{
    const ra=rankOf(a), rb=rankOf(b);
    const va=RANK_VAL[ra], vb=RANK_VAL[rb];
    if(va!==vb) return va-vb;
    return a.at(-1).localeCompare(b.at(-1));
  });
}
function validSet(cards){
  if(!Array.isArray(cards)||cards.length===0||cards.length>4) return false;
  const ranksNoTwo = cards.filter(c=>!isTwo(c)).map(rankOf);
  if(ranksNoTwo.length===0) return true; // all 2s
  return ranksNoTwo.every(r=>r===ranksNoTwo[0]);
}
function setEffectiveRankVal(cards){
  const ranksNoTwo = cards.filter(c=>!isTwo(c)).map(rankOf);
  if(ranksNoTwo.length===0) return RANK_VAL['2'];
  return RANK_VAL[ranksNoTwo[0]].valueOf();
}
function nextAliveIdx(room, idx){ let i=idx; for(let k=0;k<room.players.length;k++){ i=(i+1)%room.players.length; if(!room.players[i].finished) return i; } return idx; }

const rooms = new Map();
// room = { code, players:[{id,name,hand:[],finished:false,finishOrder:null,role:null}], hostId, started:false, deckCount:1, deck:[], trick:{leaderId,lastPlay,count,topRankVal,pile:[]}, turnIdx:0, passesInRow:0, finishRankCounter:1, round:1, scores:{}, spin:{active:false,candidates:[],winnerId:null} }

function publicPlayers(room){
  return room.players.map(p=>({ id:p.id, name:p.name, handCount:p.hand.length, finished:p.finished, finishOrder:p.finishOrder, role:p.role, score: room.scores[p.id]||0 }));
}
function broadcastState(room){
  const state = { code: room.code, hostId: room.hostId, started: room.started, players: publicPlayers(room), trick: room.trick, turnPlayerId: room.players[room.turnIdx]?.id || null, round: room.round, deckCount: room.deckCount||1, spin: room.spin||{active:false} };
  io.to(room.code).emit('state', state);
}

function assignRoles(room){
  const fin = room.players.filter(p=>p.finished).sort((a,b)=>a.finishOrder-b.finishOrder);
  const unfin = room.players.filter(p=>!p.finished);
  const order = fin.concat(unfin);
  order.forEach(p=>p.role=null);

  const n = order.length;
  if(n===2){
    order[0].role='President';
    order[1].role='Asshole';
  } else if(n===3){
    order[0].role='President';
    order[1].role='Citizen';
    order[2].role='Asshole';
  } else {
    order[0] && (order[0].role='President');
    order[1] && (order[1].role='Vice-President');
    order[n-2] && (order[n-2].role='Vice-Asshole');
    order[n-1] && (order[n-1].role='Asshole');
    for(let i=2;i<=n-3;i++){ if(order[i] && !order[i].role) order[i].role='Citizen'; }
  }
}
function pickHighest(h,c){ return sortHand(h).slice(-c); }
function pickLowest(h,c){ return sortHand(h).slice(0,c); }

function doSwaps(room){
  const n = room.players.length;
  const pres = room.players.find(p=>p.role==='President');
  const a   = room.players.find(p=>p.role==='Asshole');
  const vp  = room.players.find(p=>p.role==='Vice-President');
  const va  = room.players.find(p=>p.role==='Vice-Asshole');

  function swapCards(receiver,giver,give,take){
    give.forEach(c=>{ const i=receiver.hand.indexOf(c); if(i>-1) receiver.hand.splice(i,1); });
    take.forEach(c=>{ const i=giver.hand.indexOf(c); if(i>-1) giver.hand.splice(i,1); });
    receiver.hand.push(...take); giver.hand.push(...give);
    receiver.hand=sortHand(receiver.hand); giver.hand=sortHand(giver.hand);
  }

  if(pres && a){
    const bestA = pickHighest(a.hand,2);
    const worstP= pickLowest(pres.hand,2);
    swapCards(pres,a,worstP,bestA);
    io.to(pres.id).emit('swapInfo',{given:worstP, received:bestA});
    io.to(a.id).emit('swapInfo',{given:bestA, received:worstP});
  }
  if(n>=4 && vp && va){
    const bestVA = pickHighest(va.hand,1);
    const worstVP= pickLowest(vp.hand,1);
    swapCards(vp,va,worstVP,bestVA);
    io.to(vp.id).emit('swapInfo',{given:worstVP, received:bestVA});
    io.to(va.id).emit('swapInfo',{given:bestVA, received:worstVP});
  }
}

io.on('connection', socket=>{
  socket.on('createRoom', ({name, code})=>{
    const roomCode=(code||Math.random().toString(36).slice(2,7)).toUpperCase();
    if(rooms.has(roomCode)) return socket.emit('errorMsg','Room bestaat al, kies andere code.');
    const room={ code:roomCode, players:[], hostId:socket.id, started:false, deckCount:1, deck:[], trick:{leaderId:null,lastPlay:null,count:null,topRankVal:null,pile:[]}, turnIdx:0, passesInRow:0, finishRankCounter:1, round:1, scores:{}, spin:{active:false,candidates:[],winnerId:null} };
    rooms.set(roomCode, room);
    socket.join(roomCode);
    const player={ id:socket.id, name:(name||'Speler').slice(0,20), hand:[], finished:false, finishOrder:null, role:null };
    room.players.push(player);
    room.scores[player.id]=0;
    socket.emit('roomCreated', roomCode);
    broadcastState(room);
  });

  socket.on('joinRoom', ({name, code})=>{
    const room=rooms.get(code?.toUpperCase());
    if(!room) return socket.emit('errorMsg','Room niet gevonden.');
    if(room.started) return socket.emit('errorMsg','Spel is al gestart.');
    if(room.players.some(p=>p.id===socket.id)) return;
    socket.join(room.code);
    const player={ id:socket.id, name:(name||'Speler').slice(0,20), hand:[], finished:false, finishOrder:null, role:null };
    room.players.push(player);
    room.scores[player.id]=0;
    broadcastState(room);
  });

  socket.on('toggleDeckCount', ({code, deckCount})=>{
    const room=rooms.get(code?.toUpperCase()); if(!room) return;
    if(socket.id!==room.hostId) return socket.emit('errorMsg','Alleen host.');
    room.deckCount = Math.max(1, Math.min(2, deckCount|0));
    broadcastState(room);
  });

  socket.on('startGame', ({code})=>{
    const room=rooms.get(code?.toUpperCase()); if(!room) return;
    if(socket.id!==room.hostId) return socket.emit('errorMsg','Alleen host mag starten.');
    if(room.players.length<2) return socket.emit('errorMsg','Minstens 2 spelers.');

    room.started=true; room.round=1;
    room.deck=newDeck(room.deckCount||1);
    room.players.forEach(p=>{ p.hand=[]; p.finished=false; p.finishOrder=null; p.role=null; });
    for(let i=0;i<room.deck.length;i++){ room.players[i % room.players.length].hand.push(room.deck[i]); }
    room.players.forEach(p=>p.hand=sortHand(p.hand));
    room.trick={leaderId:null,lastPlay:null,count:null,topRankVal:null,pile:[]};
    room.passesInRow=0; room.finishRankCounter=1;

    const owners = room.players.filter(p=>p.hand.includes('3C'));
    if(owners.length===1){
      room.turnIdx = room.players.findIndex(p=>p.id===owners[0].id);
      room.trick.leaderId = owners[0].id;
      broadcastState(room);
      io.to(room.code).emit('hands', room.players.map(p=>({id:p.id, hand:p.hand})));
    } else if(owners.length>=2){
      room.spin={active:true,candidates:owners.map(p=>({id:p.id,name:p.name})),winnerId:null};
      broadcastState(room);
      const winner = owners[(Math.random()*owners.length)|0];
      room.spin.winnerId = winner.id;
      io.to(room.code).emit('spinStart', {candidates: room.spin.candidates, winnerId: room.spin.winnerId});
      setTimeout(()=>{
        room.turnIdx = room.players.findIndex(p=>p.id===room.spin.winnerId);
        room.trick.leaderId = room.players[room.turnIdx].id;
        room.spin={active:false,candidates:[],winnerId:null};
        broadcastState(room);
        io.to(room.code).emit('hands', room.players.map(p=>({id:p.id, hand:p.hand})));
      }, 3000);
    } else {
      let best={idx:0,val:999};
      room.players.forEach((p,idx)=>{ const v=Math.min(...p.hand.map(c=>RANK_VAL[rankOf(c)])); if(v<best.val){ best={idx,val:v}; } });
      room.turnIdx = best.idx;
      room.trick.leaderId = room.players[room.turnIdx].id;
      broadcastState(room);
      io.to(room.code).emit('hands', room.players.map(p=>({id:p.id, hand:p.hand})));
    }
  });

  socket.on('play', ({code, cards})=>{
    const room=rooms.get(code?.toUpperCase()); if(!room) return;
    const player=room.players[room.turnIdx];
    if(!player || player.id!==socket.id || player.finished) return;
    if(!Array.isArray(cards)||cards.length===0) return;
    if(cards.length>4) return socket.emit('errorMsg','Maximaal 4 kaarten.');

    for(const c of cards){ if(!player.hand.includes(c)) return socket.emit('errorMsg','Je bezit niet alle geselecteerde kaarten.'); }
    if(!validSet(cards)) return socket.emit('errorMsg','Ongeldig: leg single/pair/triple/quad van gelijke rang (2 mag aanvullen).');

    const rVal=setEffectiveRankVal(cards);

    if(room.trick.count==null){
      room.trick.count=cards.length;
      room.trick.topRankVal=rVal;
      room.trick.lastPlay={playerId:player.id, cards};
      room.trick.pile=[{playerId:player.id, cards}];
    } else {
      if(cards.length<room.trick.count) return socket.emit('errorMsg',`Minimaal ${room.trick.count} kaart(en).`);
      if(rVal<room.trick.topRankVal) return socket.emit('errorMsg','Je moet even hoog of hoger spelen.');
      room.trick.count = Math.max(room.trick.count, cards.length);
      room.trick.topRankVal=rVal;
      room.trick.lastPlay={playerId:player.id, cards};
      room.trick.pile=[{playerId:player.id, cards}];
    }

    player.hand = player.hand.filter(c=>!cards.includes(c));
    io.to(room.code).emit('handsUpdate', {playerId: player.id, hand: player.hand});

    if(player.hand.length===0 && !player.finished){
      player.finished=true; player.finishOrder = (room.finishRankCounter = (room.finishRankCounter||1));
      room.finishRankCounter++;
      io.to(room.code).emit('playerFinished', {playerId: player.id, order: player.finishOrder});
    }

    if(room.players.filter(p=>!p.finished).length<=1){
      const last = room.players.find(p=>!p.finished);
      if(last && !last.finished){ last.finished=true; last.finishOrder=room.finishRankCounter++; }
      assignRoles(room);

      const ranking = room.players.slice().sort((a,b)=>a.finishOrder-b.finishOrder);
      const n = ranking.length;
      room.scores = room.scores || {};
      ranking.forEach((p,idx)=>{ const pts = (n - 1 - idx); room.scores[p.id]=(room.scores[p.id]||0)+pts; });

      room.trick={leaderId:null,lastPlay:null,count:null,topRankVal:null,pile:[]};
      room.passesInRow=0;
      io.to(room.code).emit('roundEnd', { players: publicPlayers(room), winnerId: ranking[0]?.id });
      broadcastState(room);
      return;
    }

    room.passesInRow=0;
    room.turnIdx = nextAliveIdx(room, room.turnIdx);
    broadcastState(room);
  });

  socket.on('pass', ({code})=>{
    const room=rooms.get(code?.toUpperCase()); if(!room) return;
    const player=room.players[room.turnIdx];
    if(!player || player.id!==socket.id || player.finished) return;

    room.passesInRow++;
    room.turnIdx=nextAliveIdx(room, room.turnIdx);
    const alive=room.players.filter(p=>!p.finished).length;
    if(room.passesInRow>=alive-1){
      const leaderId=room.trick.lastPlay?.playerId||player.id;
      room.trick={leaderId,lastPlay:null,count:null,topRankVal:null,pile:[]};
      room.passesInRow=0;
      const idx=room.players.findIndex(p=>p.id===leaderId);
      if(idx!==-1) room.turnIdx=idx;
      io.to(room.code).emit('trickReset', {leaderId});
    }
    broadcastState(room);
  });

  socket.on('newRound', ({code})=>{
    const room=rooms.get(code?.toUpperCase()); if(!room) return;
    if(socket.id!==room.hostId) return socket.emit('errorMsg','Alleen host mag nieuwe ronde starten.');

    room.round++;
    room.deck=newDeck(room.deckCount||1);
    room.players.forEach(p=>{ p.hand=[]; p.finished=false; p.finishOrder=null; });
    for(let i=0;i<room.deck.length;i++){ room.players[i % room.players.length].hand.push(room.deck[i]); }
    room.players.forEach(p=>p.hand=sortHand(p.hand));

    doSwaps(room);

    const owners = room.players.filter(p=>p.hand.includes('3C'));
    room.trick={leaderId:null,lastPlay:null,count:null,topRankVal:null,pile:[]};
    room.passesInRow=0; room.finishRankCounter=1;

    if((room.deckCount||1)===1 || owners.length<=1){
      const starter = owners[0] || room.players[0];
      room.turnIdx = room.players.findIndex(p=>p.id===starter.id);
      room.trick.leaderId = starter.id;
      broadcastState(room);
      io.to(room.code).emit('hands', room.players.map(p=>({id:p.id, hand:p.hand})));
    } else {
      room.spin={active:true,candidates:owners.map(p=>({id:p.id,name:p.name})),winnerId:null};
      broadcastState(room);
      const winner = owners[(Math.random()*owners.length)|0];
      room.spin.winnerId = winner.id;
      io.to(room.code).emit('spinStart', {candidates: room.spin.candidates, winnerId: room.spin.winnerId});
      setTimeout(()=>{
        room.turnIdx = room.players.findIndex(p=>p.id===room.spin.winnerId);
        room.trick.leaderId = room.players[room.turnIdx].id;
        room.spin={active:false,candidates:[],winnerId:null};
        broadcastState(room);
        io.to(room.code).emit('hands', room.players.map(p=>({id:p.id, hand:p.hand})));
      }, 3000);
    }
  });

  socket.on('rename', ({code,name})=>{
    const room=rooms.get(code?.toUpperCase()); if(!room) return;
    const p=room.players.find(p=>p.id===socket.id); if(!p) return;
    p.name=(name||'Speler').slice(0,20);
    broadcastState(room);
  });

  socket.on('claimHost', ({code})=>{
    const room=rooms.get(code?.toUpperCase()); if(!room) return;
    if(!room.players.find(p=>p.id===room.hostId)){
      room.hostId = socket.id;
      broadcastState(room);
    }
  });

  socket.on('disconnect', ()=>{
    for(const [code,room] of rooms){
      const idx=room.players.findIndex(p=>p.id===socket.id);
      if(idx!==-1){
        const wasHost=room.hostId===socket.id;
        const id=socket.id;
        room.players.splice(idx,1);
        delete room.scores[id];
        if(room.players.length===0){ rooms.delete(code); continue; }
        if(wasHost){ room.hostId=room.players[0].id; }
        room.turnIdx = room.turnIdx % room.players.length;
        broadcastState(room);
      }
    }
  });
});

server.listen(PORT, ()=> console.log(`Presidenten server draait op http://localhost:${PORT}`));
