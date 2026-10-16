import { expect, it } from 'vitest';
import { conductMeeting, type MeetingState } from '../packages/orchestrator/meeting';
it('keeps a paused unsent agenda resumable instead of misclassifying it as a blocked meeting', async () => {
  let enabled=true;const state:MeetingState={id:'m',runId:'r',topic:'G',leader:'codex',participants:['codex','dsh'],roundLimit:1,mode:'mock',status:'draft',messages:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  const result=await conductMeeting(state,{canContinue:()=>enabled,save:()=>{},request:async()=>{enabled=false;throw Error('TeamPaused');}});
  expect(result.status).toBe('interrupted');expect(result.messages).toEqual([]);expect(result.agenda).toBeUndefined();
});
