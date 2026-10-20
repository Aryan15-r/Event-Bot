local HttpService = game:GetService("HttpService")

local API_URL = "https://discord-event-bot.tgia.workers.dev/roblox/event-status"
local SECRET = "AUDITS_TGIA-secret" -- secret.... What the helly

return function(context, status, number)

	-- 1. FORCE THE CHOICE HERE
    local validStatus = status:lower()
    if validStatus ~= "cancelled" and validStatus ~= "concluded" then
        return "❌ Invalid status! Use: !estatus Cancelled OR !estatus Concluded"
    end

    -- 2. Format it correctly for the Worker (First letter uppercase)
    local formattedStatus = validStatus:sub(1,1):upper() .. validStatus:sub(2)

	local EventFlag = game.ServerStorage:WaitForChild("EventHosted")
	
	local executor = context.Executor

	if executor:GetRankInGroup(14720761) < 100 then
		return "❌ You do not have permission."
	end

	local payload = {
		key = SECRET,
		ts = os.time(),
		playerId = executor.UserId,
		playerName = executor.Name,
		status = status,
		number = number,
		guild_id = "1429172254981492798",
	}

	local success, err = pcall(function()
		HttpService:PostAsync(
			API_URL,
			HttpService:JSONEncode(payload),
			Enum.HttpContentType.ApplicationJson
		)
	end)

	if not success then
		warn(err)
		return "❌ Failed to update status."
	end

	EventFlag.Value = false
	return "✅ Event status updated."
end
