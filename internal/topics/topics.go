package topics

type Pack struct {
	ID          string
	Name        string
	Description string
	Difficulty  string
	Tags        []string
	Topics      []string
}

func PresetPacks() []Pack {
	return []Pack{
		{
			ID:          "everyday",
			Name:        "Everyday Sparks",
			Description: "Low-friction opinions and stories for a first game.",
			Difficulty:  "Easy",
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
			ID:          "story",
			Name:        "Story Time",
			Description: "Personal stories that keep the words coming.",
			Difficulty:  "Easy",
			Tags:        []string{"starter", "personal"},
			Topics: []string{
				"A time you got completely lost",
				"The strangest meal you have ever eaten",
				"A plan that fell apart in the funniest way",
				"The best gift you have ever given or received",
				"A moment you were sure you were in trouble",
				"The most memorable stranger you have ever met",
				"A small victory you are still proud of",
				"The weirdest thing you believed as a kid",
			},
		},
		{
			ID:          "absurd",
			Name:        "Absurd Arguments",
			Description: "Strange prompts that reward commitment.",
			Difficulty:  "Medium",
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
			Difficulty:  "Medium",
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
		{
			ID:          "expert",
			Name:        "Instant Expert",
			Description: "Pretend mastery of topics nobody prepared for.",
			Difficulty:  "Hard",
			Tags:        []string{"party", "improv"},
			Topics: []string{
				"The complete history of the paperclip",
				"How to referee a professional staring contest",
				"The migration patterns of shopping carts",
				"Advanced techniques in competitive queue standing",
				"The economics of lost socks",
				"A field guide to office chair species",
				"The secret training regimen of weather forecasters",
				"Why ancient civilizations feared the traffic cone",
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
