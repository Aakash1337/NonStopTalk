package game

type ScoreInput struct {
	DurationSeconds  int
	SpokenSeconds    int
	Completed        bool
	AIRelevanceScore *float64
	VoteBonus        int
}

type ScorePart struct {
	Label  string
	Points int
}

func Score(input ScoreInput) int {
	score := input.SpokenSeconds
	if input.Completed && input.SpokenSeconds >= input.DurationSeconds {
		score += CompletionBonus
	}
	if input.AIRelevanceScore != nil {
		score += int((*input.AIRelevanceScore) * 20)
	}
	score += input.VoteBonus
	if score < 0 {
		return 0
	}
	return score
}

func ScoreParts(input ScoreInput) []ScorePart {
	parts := []ScorePart{
		{Label: "Speaking time", Points: input.SpokenSeconds},
	}
	if input.Completed && input.SpokenSeconds >= input.DurationSeconds {
		parts = append(parts, ScorePart{Label: "Completion bonus", Points: CompletionBonus})
	}
	if input.AIRelevanceScore != nil {
		parts = append(parts, ScorePart{Label: "AI relevance", Points: int((*input.AIRelevanceScore) * 20)})
	}
	if input.VoteBonus != 0 {
		parts = append(parts, ScorePart{Label: "Vote bonus", Points: input.VoteBonus})
	}
	return parts
}
