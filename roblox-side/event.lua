-- return {
-- 	Name = "event";
-- 	Aliases = {"ev"};
-- 	Description = "Host a Discord event from inside the game.";
-- 	Group = "DefaultAdmin";
-- 	Args = {
-- 		{
-- 			Type = "string";
-- 			Name = "event_type";
-- 			Description = "SSU / CT / GT";
-- 		},
-- 		{
-- 			Type = "string";
-- 			Name = "starts_at";
-- 			Description = "Start time.";
-- 		},
-- 		{
-- 			Type = "string";
-- 			Name = "private_link";
-- 			Description = "Private server link (optional).";
-- 			Optional = true;
-- 		},
-- 		{
-- 			Type = "string";
-- 			Name = "note";
-- 			Description = "Let you add custom notes.";
-- 			Optional = true;
-- 		}
-- 	};
-- }


-- event.lua
return {
	Name = "event";
	Aliases = {"ev"};
	Description = "Host a Discord event from inside the game.";
	Group = "DefaultAdmin";
	Args = {
		{
			Type = "string";
			Name = "event_type";
			Description = "SSU / CT / GT";
		},
		{
			Type = "string";
			Name = "starts_at";
			Description = "Start time.";
		},
		{
			Type = "string";
			Name = "co_host"; -- New Option
			Optional = true;
			Description = "Discord ID of the Co-Host.";
		},
		{
			Type = "string";
			Name = "supervisor"; -- New Option
			Optional = true;
			Description = "Discord ID of the Supervisor.";
		},
		{
			Type = "string";
			Name = "private_link";
			Description = "Private server link (optional).";
			Optional = true;
		},
		{
			Type = "string";
			Name = "note";
			Description = "Let you add custom notes.";
			Optional = true;
		}
	};
}