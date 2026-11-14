import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseCoachVoice,createCoachVoice,goodRepMessage} from '../js/coachVoice.js';
const voice=(name,lang='en-US')=>({name,lang});
test('prefers natural English voices over basic system defaults',()=>{
 const natural=voice('Microsoft Jenny Natural');
 assert.equal(chooseCoachVoice([{...voice('David'),default:true},natural,voice('French Neural','fr-FR')]),natural);
 assert.equal(chooseCoachVoice([voice('French','fr-FR')]),null);
});
function mock(){
 const spoken=[],handlers={};let voices=[];let cancels=0;
 const synth={getVoices:()=>voices,speak:u=>spoken.push(u),cancel:()=>cancels++,addEventListener:(e,f)=>handlers[e]=f,removeEventListener:(e)=>delete handlers[e]};
 const coach=createCoachVoice({synth,Utterance:class{constructor(text){this.text=text;}}});
 return {coach,spoken,handlers,setVoices:v=>voices=v,cancels:()=>cancels};
}
test('refreshes voices loaded after initialization and sets conversational pace',()=>{
 const m=mock(),natural=voice('English Enhanced');m.setVoices([natural]);m.handlers.voiceschanged();m.coach.speak('Hello.');
 assert.equal(m.spoken[0].voice,natural);assert.equal(m.spoken[0].rate,0.96);
});
test('finishes current feedback and keeps only the latest pending cue',()=>{
 const m=mock();m.coach.speak('One.');m.coach.speak('Two.');m.coach.speak('Three.');
 assert.equal(m.spoken.length,1);assert.equal(m.cancels(),0);
 m.spoken[0].onend();assert.equal(m.spoken[1].text,'Three.');
});
test('urgent countdown interrupts and cancelled callbacks cannot replay stale cues',()=>{
 const m=mock();m.coach.speak('Old.');m.coach.speak('Pending.');const old=m.spoken[0];
 m.coach.speak('3',{interrupt:true});old.onend();assert.deepEqual(m.spoken.map(u=>u.text),['Old.','3']);
 m.coach.stop();m.spoken[1].onend();assert.equal(m.spoken.length,2);
});
test('unsupported speech safely does nothing and encouragement varies',()=>{
 assert.doesNotThrow(()=>createCoachVoice({synth:null,Utterance:null}).speak('Hello'));
 assert.notEqual(goodRepMessage(1),goodRepMessage(2));
});
