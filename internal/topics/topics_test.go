package topics

import "testing"

func TestPresetPacksAreValid(t *testing.T) {
	packs := PresetPacks()
	if len(packs) < 3 {
		t.Fatalf("expected at least 3 preset packs, got %d", len(packs))
	}

	validDifficulties := map[string]bool{"Easy": true, "Medium": true, "Hard": true}
	seenIDs := map[string]bool{}
	for _, pack := range packs {
		if pack.ID == "" {
			t.Errorf("pack %q has empty ID", pack.Name)
		}
		if seenIDs[pack.ID] {
			t.Errorf("duplicate pack ID %q", pack.ID)
		}
		seenIDs[pack.ID] = true
		if pack.Name == "" {
			t.Errorf("pack %q has empty name", pack.ID)
		}
		if !validDifficulties[pack.Difficulty] {
			t.Errorf("pack %q has invalid difficulty %q", pack.ID, pack.Difficulty)
		}
		if len(pack.Topics) < 5 {
			t.Errorf("pack %q has only %d topics, want at least 5", pack.ID, len(pack.Topics))
		}
		seenTopics := map[string]bool{}
		for _, topic := range pack.Topics {
			if topic == "" {
				t.Errorf("pack %q contains an empty topic", pack.ID)
			}
			if seenTopics[topic] {
				t.Errorf("pack %q has duplicate topic %q", pack.ID, topic)
			}
			seenTopics[topic] = true
		}
	}
}

func TestFindPack(t *testing.T) {
	pack, ok := FindPack("everyday")
	if !ok || pack.ID != "everyday" {
		t.Fatalf("expected to find everyday pack, got %v %v", pack, ok)
	}
	if _, ok := FindPack("missing"); ok {
		t.Fatal("expected missing pack lookup to fail")
	}
}
