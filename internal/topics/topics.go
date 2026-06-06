package topics

type Pack struct {
	ID          string
	Name        string
	Description string
	Tags        []string
	Topics      []string
}

func PresetPacks() []Pack {
	return []Pack{
		{
			ID:          "everyday",
			Name:        "Everyday Sparks",
			Description: "Low-friction opinions and stories for a first game.",
			Tags:        []string{"starter", "work-safe"},
			Topics: []string{
				"The best breakfast food and why everyone else is wrong",
				"A tiny convenience that makes life dramatically better",
				"The most overrated household item",
				"Something everyone should try once",
				"A harmless rule you would add to daily life",
				"The best way to spend a rainy afternoon",
				"A skill that looks easy until you try it",
				"The ideal snack for a long road trip",
			},
		},
		{
			ID:          "absurd",
			Name:        "Absurd Arguments",
			Description: "Strange prompts that reward commitment.",
			Tags:        []string{"party", "chaotic"},
			Topics: []string{
				"Why spoons deserve more respect than forks",
				"The official rules for living with a dragon roommate",
				"How to convince aliens that humans are normal",
				"Why elevators should have theme music",
				"The business case for professional pillow fighting",
				"How you would run a city where everyone walks backward",
				"Why clouds are suspicious",
				"The hidden politics of sandwich shapes",
			},
		},
		{
			ID:          "debate",
			Name:        "Fast Debate",
			Description: "Clear positions for louder groups.",
			Tags:        []string{"debate", "sharp"},
			Topics: []string{
				"Remote work is better than office work",
				"Movies are better when they are shorter",
				"Every city should ban cars from one street downtown",
				"Board games are better than video games at parties",
				"Cooking is more useful than coding",
				"Schools should teach negotiation",
				"Everyone should have to work in customer service once",
				"Public libraries are underrated infrastructure",
			},
		},
	}
}

func FindPack(id string) (Pack, bool) {
	for _, pack := range PresetPacks() {
		if pack.ID == id {
			return pack, true
		}
	}
	return Pack{}, false
}
