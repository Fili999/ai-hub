-- Source of "AI Hub.app" (compiled by packaging/build.mjs with: osacompile -s). A small stay-open applet that gives the
-- hub a real Mac app shell: a Dock icon, Quit that really stops the hub, and clicking the app again re-opens the page.
-- All the work is done by Contents/Resources/start.sh (which runs the bundled Node), so there is nothing to install.
property hubPid : ""

on run
	my startHub()
end run

on reopen
	my startHub()
end reopen

on startHub()
	set startScript to (POSIX path of (path to me)) & "Contents/Resources/start.sh"
	try
		set newPid to do shell script quoted form of startScript
	on error
		quit
		return
	end try
	-- when the hub was already running, the new process opens the page and ends: keep following the original one
	if hubPid is "" or not my isAlive(hubPid) then set hubPid to newPid
end startHub

on isAlive(thePid)
	try
		do shell script "kill -0 " & thePid
		return true
	on error
		return false
	end try
end isAlive

-- every few seconds: when the hub has stopped (page closed for a while, or it failed to start), the app quits too
on idle
	if hubPid is not "" and not my isAlive(hubPid) then quit
	return 3
end idle

on quit
	if hubPid is not "" then
		try
			do shell script "kill " & hubPid
		end try
	end if
	continue quit
end quit
