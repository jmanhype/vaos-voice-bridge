/**
 * Belief state schema — the Reasoner's model of the user.
 * Stored in Letta agent core memory and updated after each conversation turn.
 * The Talker reads the latest belief to prime its responses.
 */

export interface BeliefState {
  userModel: {
    goals: string[];
    currentProject: string | null;
    preferences: {
      voice: string;
      verbosity: 'concise' | 'detailed';
    };
    barriers: string[];
    expertiseLevel: 'beginner' | 'intermediate' | 'advanced';
  };
  conversation: {
    phase: 'understanding' | 'planning' | 'action';
    topic: string | null;
    turnsInPhase: number;
    summary: string;
  };
  pendingActions: Array<{ type: string; id: string; status: string }>;
  lastReasonerUpdate: string;
}

export function emptyBelief(): BeliefState {
  return {
    userModel: {
      goals: [],
      currentProject: null,
      preferences: { voice: 'NATF0.pt', verbosity: 'concise' },
      barriers: [],
      expertiseLevel: 'advanced',
    },
    conversation: {
      phase: 'understanding',
      topic: null,
      turnsInPhase: 0,
      summary: '',
    },
    pendingActions: [],
    lastReasonerUpdate: new Date().toISOString(),
  };
}

/** Convert belief state into a PersonaPlex text_prompt that primes the Talker. */
export function beliefToPrompt(belief: BeliefState): string {
  const parts: string[] = [
    'You are a voice assistant for the VAOS autonomous operating system.',
    'Keep responses concise and natural for spoken conversation.',
  ];

  if (belief.userModel.currentProject) {
    parts.push(`The user is currently working on: ${belief.userModel.currentProject}.`);
  }

  if (belief.userModel.goals.length > 0) {
    parts.push(`Their goals: ${belief.userModel.goals.join(', ')}.`);
  }

  if (belief.conversation.topic) {
    parts.push(`Current conversation topic: ${belief.conversation.topic}.`);
  }

  if (belief.conversation.summary) {
    parts.push(`Context: ${belief.conversation.summary}`);
  }

  if (belief.pendingActions.length > 0) {
    const actionDescs = belief.pendingActions.map(
      (a) => `${a.type}:${a.id} (${a.status})`,
    );
    parts.push(`Pending actions: ${actionDescs.join(', ')}.`);
  }

  return parts.join(' ');
}
