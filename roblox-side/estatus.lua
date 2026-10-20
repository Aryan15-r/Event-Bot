-- return {
-- 	Name = "estatus";
-- 	Aliases = {"eventstatus"};
-- 	Description = "Updates latest hosted event status.";
-- 	Group = "DefaultAdmin";
-- 	Args = {
-- 		{
-- 			Type = "string";
-- 			Name = "status";
-- 			Description = "Changes event status to => Cancelled / Concluded.";
-- 		},
-- 		{
-- 			Type = "number";
-- 			Name = "number";
-- 			Optional = true;
-- 			Description = "Event marking number (for concluded only).";
-- 		},
-- 	};
-- }

return {
	Name = "estatus";
	Aliases = {"eventstatus"};
	Description = "Updates latest hosted event status.";
	Group = "DefaultAdmin";
	Args = {
		{
			Type = "string";
			Name = "status";
			-- Updated description to show available options
			Description = "Status must be: Cancelled or Concluded";
		},
		{
			Type = "number";
			Name = "number";
			Optional = true;
			Description = "Event marking number (for concluded only).";
		},
	};
}
