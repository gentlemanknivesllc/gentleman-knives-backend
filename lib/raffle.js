// lib/raffle.js
// Shared logic for the raffle's knife-count tiers. Only PAID entries count
// toward these thresholds — free entries affect individual odds but never
// move the bar, per the design: the prize size is funded by paid
// participation, while the sweepstakes itself stays equal-odds for everyone.

const STAGES = [
  { knives: 3, paidEntriesNeeded: 0 },   // guaranteed floor, not a goal to reach
  { knives: 6, paidEntriesNeeded: 25 },
  { knives: 10, paidEntriesNeeded: 50 },
  { knives: 15, paidEntriesNeeded: 90 },
  { knives: 20, paidEntriesNeeded: 150 } // capped — paid entries can keep coming in past this, but the prize stops growing
];

const ENTRY_PRICE = 5; // dollars per paid entry

// Given a real paid-entry count, returns the current stage info and enough
// detail for the frontend to render the bar and pick the right graphic.
function getRaffleStatus(paidEntryCount) {
  let currentStageIndex = 0;
  for (let i = STAGES.length - 1; i >= 0; i--) {
    if (paidEntryCount >= STAGES[i].paidEntriesNeeded) {
      currentStageIndex = i;
      break;
    }
  }

  const currentStage = STAGES[currentStageIndex];
  const nextStage = STAGES[currentStageIndex + 1] || null;

  let progressToNextStage = 1; // fully maxed out if there's no next stage
  if (nextStage) {
    const span = nextStage.paidEntriesNeeded - currentStage.paidEntriesNeeded;
    const into = paidEntryCount - currentStage.paidEntriesNeeded;
    progressToNextStage = span > 0 ? Math.min(1, into / span) : 1;
  }

  return {
    paidEntryCount,
    dollarTotal: paidEntryCount * ENTRY_PRICE,
    currentKnives: currentStage.knives,
    currentStageIndex,
    isMaxed: nextStage === null,
    nextStage: nextStage
      ? { knives: nextStage.knives, entriesNeeded: nextStage.paidEntriesNeeded, entriesRemaining: nextStage.paidEntriesNeeded - paidEntryCount }
      : null,
    progressToNextStage,
    stages: STAGES // full list, so the frontend can render all the bar's markers
  };
}

module.exports = { STAGES, ENTRY_PRICE, getRaffleStatus };
