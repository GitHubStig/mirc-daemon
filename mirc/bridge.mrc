; ============================================================================
;  mirc-daemon bridge
;
;  Speaks MBP: newline-delimited JSON over a raw TCP socket to the daemon.
;  Put this file and bridge.ini together in the mIRC folder (//echo -a $mircdir)
;  or in its scripts\ subfolder.
;  Load with:  /load -rs bridge.mrc
;  Start with: /bridge.start    (remote.ini does it on START, or run it by hand)
;
;  The daemon's constraints drive most of what follows:
;   * every line must end in a newline, or its reader stalls on a partial buffer
;   * keep lines well under 3500 bytes
;   * nothing is fire-and-forget: join/connect/ison answer with a `res`
;
;  TWO mSL TRAPS this file exists with, both of which failed silently:
;
;  1. $foo.bar is parsed as identifier `foo` with property `bar`. An alias named
;     `bridge.host` referenced as `$bridge.host` is $null. So every internal alias
;     uses underscores; dotted names are only safe when invoked as commands.
;
;  2. There is no clean way to read the Nth argument of a variadic alias --
;     $($i, 2) does NOT mean "argument $i" (it evaluates $i as an identifier).
;     So frames are built by explicit concatenation rather than a key/value
;     helper. Verbose, but it produces the JSON you can read here.
;
;  This script touches no files except reading bridge.ini.
; ============================================================================

; --- config ---------------------------------------------------------------
; bridge.ini lives next to this script. Deriving that folder from $script() and
; $nofile() looked tidy and was silently wrong (a relative path made the length
; arithmetic produce a truncated prefix), so check the two places it can be.

alias -l bridge_inifile {
  var %root = $iif($right($mircdir, 1) == $chr(92), $mircdir, $mircdir $+ $chr(92))
  var %inroot = %root $+ bridge.ini
  if ($isfile(%inroot)) return %inroot
  var %inscripts = %root $+ scripts $+ $chr(92) $+ bridge.ini
  if ($isfile(%inscripts)) return %inscripts
  return %inroot
}
alias -l bridge_host { return $readini($bridge_inifile, bridge, host) }
alias -l bridge_port { return $readini($bridge_inifile, bridge, port) }
alias -l bridge_token { return $readini($bridge_inifile, bridge, token) }

; The current connection's network name, falling back to the server address.
; "Current" is the event's connection inside an event handler, and the one
; selected with /scid inside a command.
alias -l bridge_net { return $iif($network, $network, $server) }

; The bridge's own messages go to a window of their own. `echo -a` followed
; whatever window had focus, so "lost the daemon connection" landed in the
; middle of a channel; a status window is no better once there are several
; connections. -n opens it minimised: mIRC highlights it without taking focus.
alias -l bridge_say {
  if (!$window(@bridge)) window -n @bridge
  echo -t @bridge * bridge: $1-
}

; --- JSON out -------------------------------------------------------------
; Built from $chr() constants: a literal { at the start of a token would open a
; block, and a literal quote would end the string.
;
; Written inline rather than behind helper aliases on purpose. Short names like
; `cb` and `cm` were shadowed by something else in this mIRC setup: $cb returned
; unrelated text, so the closing brace became the string "/bridge.start" and the
; frame looked plausible in the daemon log while being invalid JSON. Two-letter
; alias names are not worth the risk.

; Quote and escape a string for JSON.
;
; Every control character must be escaped, not just newline/CR/tab: IRC's own
; formatting codes (^B bold, ^C colour, ^O reset, ^_ underline) are control
; characters, and JSON.parse rejects them raw. Missing this made every coloured
; line -- which is most XDCC bot output -- unparseable and silently dropped.
; The loop only runs when the regex says there is something to escape.
alias -l jstr {
  var %s = $replace($1-, $chr(92), $chr(92) $+ $chr(92))
  %s = $replace(%s, $chr(34), $chr(92) $+ $chr(34))
  %s = $replace(%s, $chr(10), $chr(92) $+ n)
  %s = $replace(%s, $chr(13), $chr(92) $+ r)
  %s = $replace(%s, $chr(9), $chr(92) $+ t)
  if ($regex(%s, /[\x01-\x1f]/)) {
    var %i = 1
    while (%i < 32) {
      %s = $replace(%s, $chr(%i), $chr(92) $+ u00 $+ $base(%i, 10, 16, 2))
      inc %i
    }
  }
  return $chr(34) $+ %s $+ $chr(34)
}

; "key":value  -- the value must already be JSON, passed as an identifier result
; so that spaces inside it survive.
alias -l kvo { return $jstr($1) $+ $chr(58) $+ $2 }

; Prefix shared by every event frame: {"t":"ev","kind":"...","cid":N,"net":"..."
; The connection id is what tells two connections to one network apart, and
; what the daemon keys its model on; the name is for people.
alias -l evp {
  return $chr(123) $+ $kvo(t, $jstr(ev)) $+ $chr(44) $+ $kvo(kind, $jstr($1)) $+ $chr(44) $+ $kvo(cid, $cid) $+ $chr(44) $+ $kvo(net, $jstr($bridge_net))
}

; Prefix shared by every reply: {"t":"res","id":"..."
alias -l reshead { return $chr(123) $+ $kvo(t, $jstr(res)) $+ $chr(44) $+ $kvo(id, $jstr($1)) }

; --- JSON in --------------------------------------------------------------
; Parsed with mIRC's regex engine rather than $pos/$mid arithmetic. The
; arithmetic version was off by a character in a way that was invisible, and a
; failed parse is silent here: the command simply never runs and the daemon
; reports a timeout. Regex is one expression, no offsets to get wrong.

;
; This reads a string value only up to the next quote, which is correct here by
; construction rather than by luck: the daemon's own envelope fields (t, id,
; action) never contain quotes or backslashes, and every command param arrives
; as base64, which cannot. An earlier version had to read and unescape full
; JSON strings in mSL; that is where `say "hi"` turned into `say \`.
alias -l jval {
  var %pat = / $+ $chr(34) $+ $2 $+ $chr(34) $+ $chr(58) $+ $chr(34) $+ ([^ $+ $chr(34) $+ ]*) $+ $chr(34) $+ /
  if ($regex($1, %pat)) return $regml(1)
}

; A command param: base64 on the wire (since protocol v2), decoded here.
; Decoded through a binary variable so the bytes are read back as UTF-8 text
; rather than one character per byte. The daemon has already turned line
; breaks into spaces, so the result is always safe to hand to /msg.
; Verified live (mIRC 7.85, 2026-10-22): $bvar().text decodes UTF-8; /bridge.diag's
; b64-test checks it on every run.
alias -l jparam {
  var %b64 = $jval($1, $2)
  if (%b64 == $null) return
  ; A binvar is not truncated by bset, so clear it or a longer earlier value
  ; would leave its tail on this one.
  bunset &bridge_b64
  bset -t &bridge_b64 1 %b64
  noop $decode(&bridge_b64, bm)
  return $bvar(&bridge_b64, 1-).text
}

alias -l jnum {
  var %pat = / $+ $chr(34) $+ $2 $+ $chr(34) $+ $chr(58) $+ ([0-9]+) $+ /
  if ($regex($1, %pat)) return $regml(1)
}

; --- connection -----------------------------------------------------------

alias -l bridge_send {
  if (!$sock(bridge)) return
  sockwrite -n bridge $1-
}

alias bridge.start {
  .timerbridgeconn off
  ; Force a fresh link. Reloading the script leaves the old socket open, and a
  ; stale connection means the daemon never re-queries state -- which looks
  ; exactly like a hang, because nothing is sent and nothing arrives.
  if ($sock(bridge)) sockclose bridge
  ; A manual start should report what happens next, even mid-outage.
  unset %bridge_down
  bridge_connect
  .timerbridgeconn 1 10 bridge_connect
}

alias bridge.stop {
  ; Every retry path uses this one timer name, so this cancels all of them.
  .timerbridgeconn off
  if ($sock(bridge)) sockclose bridge
  unset %bridge_down
  bridge_say stopped
}

; Diagnostic you can run from the editbox; deliberately never prints the token.
; Written to @bridge, which is brought forward so the output is not missed.
alias bridge.diag {
  bridge_say inifile = $bridge_inifile
  bridge_say host = $bridge_host port = $bridge_port token = $iif($bridge_token, set, MISSING)
  bridge_say socket = $iif($sock(bridge), $sock(bridge), not-open)
  bridge_say mircdir = $mircdir
  bridge_say hello = $bridge_helloframe(***)
  bridge_say last-in = $iif(%bridge_last, %bridge_last, nothing received yet)
  bridge_say conns = $bridge_connspayload
  ; Self-test for the inbound reader, using the same builders as a real frame.
  var %probe = $chr(123) $+ $kvo(t, $jstr(cmd)) $+ $chr(44) $+ $kvo(id, $jstr(c1)) $+ $chr(44) $+ $kvo(action, $jstr(conns)) $+ $chr(125)
  bridge_say jval-test t= $+ $jval(%probe, t) $+ id= $+ $jval(%probe, id) $+ action= $+ $jval(%probe, action)
  ; The param decoder, run inside mIRC itself. The vector is the daemon's
  ; encoding of: say "hi" C:\dir u-umlaut ^B b -- a quote pair, a backslash,
  ; a non-ASCII letter and an IRC bold code, each of which broke a reader once.
  var %frame = $chr(123) $+ $kvo(text, $jstr(c2F5ICJoaSIgQzpcZGlyIMO8AmI=)) $+ $chr(125)
  var %want = say $chr(34) $+ hi $+ $chr(34) C:\dir $chr(252) $+ $chr(2) $+ b
  var %got = $jparam(%frame, text)
  bridge_say b64-test $iif(%got === %want, ok, FAILED got= $+ %got)
  window -a @bridge
}

; Sends a known frame straight down the socket, bypassing everything else.
; If this shows up in the daemon log, writing works and the fault is earlier.
alias bridge.test {
  if (!$sock(bridge)) { bridge_say socket is not open, cannot write | return }
  bridge_send $chr(123) $+ $kvo(t, $jstr(pong)) $+ $chr(125)
  bridge_say sent test frame, sockerr = $sock(bridge).wserr
}

; Built in one place so the diagnostic can show exactly what would be sent.
; $1 = token, so the diagnostic can pass a mask instead.
alias -l bridge_helloframe {
  return $chr(123) $+ $kvo(t, $jstr(hello)) $+ $chr(44) $+ $kvo(v, 3) $+ $chr(44) $+ $kvo(token, $jstr($1)) $+ $chr(44) $+ $kvo(nick, $jstr($me)) $+ $chr(44) $+ $kvo(mirc, $jstr($version)) $+ $chr(125)
}

; Not -l: it is run from a timer, and whether a timer may call a local alias is
; not something to bet the reconnect loop on. The same applies to every
; *_timeout alias below.
alias bridge_connect {
  ; A missing or unreadable bridge.ini otherwise surfaces as "sockopen:
  ; insufficient parameters", which says nothing useful. Say what is wrong.
  if (!$bridge_host || !$bridge_port || !$bridge_token) {
    bridge_say cannot read host/port/token from $bridge_inifile
    bridge_say copy bridge.ini next to bridge.mrc, with [bridge] host/port/token
    return
  }
  ; Never disturb a live socket; SOCKCLOSE is what brings us back.
  if ($sock(bridge)) return
  sockopen bridge $bridge_host $bridge_port
}

on *:START: { bridge.start }

on *:SOCKOPEN:bridge: {
  ; A refused connection lands here with $sockerr set and never reaches
  ; SOCKCLOSE, so without this retry a daemon that was down when mIRC started
  ; would never be found.
  if ($sockerr) {
    bridge_down daemon not reachable at $bridge_host $+ : $+ $bridge_port $+ , retrying every 10s
    .timerbridgeconn 1 10 bridge_connect
    return
  }
  if (%bridge_down) { bridge_say reconnected to the daemon | unset %bridge_down }
  ; Identify first; the daemon answers `welcome` and then asks for state.
  bridge_send $bridge_helloframe($bridge_token)
}

on *:SOCKCLOSE:bridge: {
  bridge_down lost the daemon connection, retrying every 5s
  .timerbridgeconn 1 5 bridge_connect
}

; Say so once when the link goes down, not on every retry: a silent retry
; loop is indistinguishable from a script that is doing nothing at all.
alias -l bridge_down {
  if (%bridge_down) return
  set -e %bridge_down 1
  bridge_say $1-
}

; --- read loop ------------------------------------------------------------

on *:SOCKREAD:bridge: {
  ; Read until nothing is left. Guarded by $sockbr (bytes read by the last
  ; /sockread) rather than $sock().rq: if that property is ever falsy the loop
  ; body never runs and the socket silently never gets drained.
  ; The counter is a backstop against looping forever on a stuck buffer.
  var %line, %i = 0
  while (%i < 50) {
    inc %i
    sockread %line
    if ($sockerr) return
    if ($sockbr == 0) return
    if (%line != $null) {
      ; -e keeps it out of mIRC's saved variables, and a connect frame is not
      ; kept at all because it may carry a server password.
      if (*"password"* !iswm %line) set -e %bridge_last %line
      bridge_dispatch %line
    }
  }
}

alias -l bridge_dispatch {
  var %t = $jval($1-, t)
  ; An unparseable frame used to vanish silently; make it visible instead.
  if (%t == $null) { bridge_say unparsed frame: $1- | return }
  if (%t == ping) { bridge_send $chr(123) $+ $kvo(t, $jstr(pong)) $+ $chr(125) | return }
  ; The daemon refused us (e.g. a protocol mismatch). Say why and stop
  ; retrying, rather than reconnecting every few seconds to be refused again.
  ; The reason is daemon-written plain ASCII, so jval reads it as-is.
  if (%t == bye) { bridge_say daemon refused: $jval($1-, reason) | bridge.stop | return }
  if (%t == cmd) bridge_command $jval($1-, id) $jval($1-, action) $1-
}

; --- replies --------------------------------------------------------------

; $1 = id, $2- = extra JSON members, without a leading comma. The daemon reads
; them from `res.data`, so they are wrapped rather than left at the top level.
alias -l bridge_ok {
  if ($2-) bridge_send $reshead($1) $+ $chr(44) $+ $kvo(ok, true) $+ $chr(44) $+ $kvo(data, $chr(123) $+ $2- $+ $chr(125)) $+ $chr(125)
  else bridge_send $reshead($1) $+ $chr(44) $+ $kvo(ok, true) $+ $chr(125)
}

; $1 = id, $2 = numeric (0 for none), $3- = message
alias -l bridge_fail {
  bridge_send $reshead($1) $+ $chr(44) $+ $kvo(ok, false) $+ $chr(44) $+ $kvo(numeric, $2) $+ $chr(44) $+ $kvo(err, $jstr($3-)) $+ $chr(125)
}

; --- commands -------------------------------------------------------------
; $1 = id, $2 = action, $3- = the whole frame (params are read out of it)
;
; A command that names a connection (`cid`) is run on that connection. /scid
; switches it for the rest of this script run, so the switch is undone first:
; one SOCKREAD can carry several frames, and a command that names no connection
; must not inherit the previous frame's.

alias -l bridge_command {
  var %id = $1, %act = $2, %f = $3-
  scid -r
  var %cid = $jnum(%f, cid)
  if (%cid != $null) {
    if (!$bridge_hascid(%cid)) { bridge_fail %id 0 no-such-connection | return }
    scid %cid
  }
  if (%act == conns) { bridge_ok %id $bridge_connspayload | return }
  if (%act == chans) { bridge_do_chans %id | return }
  if (%act == members) { bridge_do_members %id $jparam(%f, channel) $jparam(%f, nick) | return }
  if (%act == ison) { bridge_do_ison %id $jparam(%f, list) | return }
  if (%act == join) { bridge_do_join %id $jparam(%f, channel) $jparam(%f, key) | return }
  if (%act == part) { bridge_do_part %id $jparam(%f, channel) | return }
  if (%act == msg) { bridge_do_msg %id $jparam(%f, target) $jparam(%f, text) | return }
  if (%act == notice) { bridge_do_notice %id $jparam(%f, target) $jparam(%f, text) | return }
  if (%act == echo) { bridge_do_echo %id $jparam(%f, text) | return }
  ; Port is always passed (0 for none) so a password cannot shift into its slot.
  ; Numbers are not encoded, so the port is read with jnum.
  ; A cid on connect means "reconnect that window" (already selected above).
  if (%act == connect) { bridge_do_connect %id $jparam(%f, server) $iif($jnum(%f, port), $v1, 0) $iif(%cid != $null, 1, 0) $iif($jnum(%f, tls), 1, 0) $jparam(%f, password) | return }
  if (%act == raw) { bridge_do_raw %id $jparam(%f, line) | return }
  if (%act == nick) { bridge_do_nick %id $jparam(%f, nick) | return }
  if (%act == disconnect) { bridge_do_disconnect %id $jparam(%f, message) | return }
  if (%act == dccstop) { bridge_do_dccstop %id $jparam(%f, nick) | return }
  bridge_fail %id 0 unknown-action-$+(%act)
}

; --- connections and state ------------------------------------------------
; State is two commands rather than one. `conns` lists every connection in a
; line each; `chans` gives one connection's channels. The daemon asks for the
; list, then the channels of each connected one, and assembles the picture. No
; single frame has to describe everything mIRC is in, and mSL stays a lookup.
;
; Verified live (mIRC 7.85, 2026-10-22): $scon(N) returns the Nth connection's id
; (window numbers like 607, not 1, 2, 3), /scid N switches to it, and $sreq
; reports the DCC send-request setting. /bridge.diag prints conns.

; Every connection id, space-separated.
alias -l bridge_cids {
  var %out, %i = 1
  while (%i <= $scon(0)) {
    %out = %out $scon(%i)
    inc %i
  }
  return %out
}

alias -l bridge_hascid { return $istok($bridge_cids, $1, 32) }

; The payload is separate from the reply so the diagnostic can show it.
alias -l bridge_connspayload {
  var %out, %i = 1
  while (%i <= $scon(0)) {
    scid $scon(%i)
    ; $status also has "loggingon"; the daemon folds it into "connecting".
    if (%i > 1) %out = %out $+ $chr(44)
    %out = %out $+ $chr(123) $+ $kvo(cid, $cid) $+ $chr(44) $+ $kvo(net, $jstr($network)) $+ $chr(44) $+ $kvo(server, $jstr($server)) $+ $chr(44) $+ $kvo(status, $jstr($status)) $+ $chr(44) $+ $kvo(nick, $jstr($me)) $+ $chr(125)
    inc %i
  }
  scid -r
  return $kvo(conns, $chr(91) $+ %out $+ $chr(93)) $+ $chr(44) $+ $kvo(sreq, $jstr($sreq))
}

; One connection's channels and member counts. Runs after bridge_command has
; switched to the connection the daemon named.
alias -l bridge_do_chans {
  var %names, %counts, %i = 1
  while (%i <= $chan(0)) {
    if (%i > 1) %names = %names $+ $chr(44)
    %names = %names $+ $jstr($chan(%i))
    if (%i > 1) %counts = %counts $+ $chr(44)
    %counts = %counts $+ $jstr($chan(%i)) $+ $chr(58) $+ $nick($chan(%i), 0)
    inc %i
  }
  bridge_ok $1 $kvo(channels, $chr(91) $+ %names $+ $chr(93)) $+ $chr(44) $+ $kvo(members, $chr(123) $+ %counts $+ $chr(125))
}

; $1 = id, $2 = channel, $3 = optional nick to test for.
; With a nick, only presence is reported. Without one, names stop at ~2500
; characters: a full XDCC channel's list is many times the frame limit, and the
; daemon drops an overlong line, which turned this into a 10s timeout.
alias -l bridge_do_members {
  var %ch = $2, %who = $3
  ; $nick() of a channel we are not in is $null, which made "count": invalid JSON.
  if ($me !ison %ch) { bridge_fail $1 0 not-on-channel | return }
  var %head = $kvo(count, $nick(%ch, 0))
  if (%who != $null) {
    bridge_ok $1 %head $+ $chr(44) $+ $kvo(present, $iif(%who ison %ch, true, false))
    return
  }
  var %names, %i = 1, %more = false
  while (%i <= $nick(%ch, 0)) {
    if ($len(%names) > 2500) { %more = true | break }
    if (%i > 1) %names = %names $+ $chr(44)
    %names = %names $+ $jstr($nick(%ch, %i))
    inc %i
  }
  bridge_ok $1 %head $+ $chr(44) $+ $kvo(truncated, %more) $+ $chr(44) $+ $kvo(names, $chr(91) $+ %names $+ $chr(93))
}

; $1 = id, $2- = space-separated nicks. The daemon sends a string rather than a
; JSON array because the array was found by bracket position, and nicks such as
; [XDCC]Bot contain brackets.
alias -l bridge_do_ison {
  var %list = $2-
  if (%list == $null) { bridge_fail $1 0 missing-nicks | return }
  ; Deliberately not `set -u`: these must survive until the 303 arrives. But
  ; `-e` (unset on exit), like every pending-command variable here: a reply
  ; that never came must not leave state behind in vars.ini across a restart.
  set -e %bridge_ison_id $1
  set -e %bridge_ison_list %list
  set -e %bridge_ison_cid $cid
  .timerbridgeison 1 10 bridge_ison_timeout
  ison %list
}

alias bridge_ison_timeout {
  if (!$var(%bridge_ison_id)) return
  var %id = %bridge_ison_id
  .timerbridgeison off
  unset %bridge_ison_id %bridge_ison_list %bridge_ison_cid
  bridge_fail %id 0 ison-timeout
}

; --- join / part ----------------------------------------------------------

alias -l bridge_do_join {
  ; Joining a channel we are already in makes the server say nothing at all, so
  ; this used to sit until the daemon timed out.
  if ($me ison $2) {
    bridge_ok $1 $kvo(joined, $jstr($2)) $+ $chr(44) $+ $kvo(members, $nick($2, 0)) $+ $chr(44) $+ $kvo(already, true)
    return
  }
  set -e %bridge_join_id $1
  set -e %bridge_join_chan $2
  ; The same channel name can exist on several networks; only this
  ; connection's 366 or refusal may answer.
  set -e %bridge_join_cid $cid
  ; Give up before the daemon does (its default is 10s), so a refusal this
  ; script does not recognise is reported and the pending id is cleared rather
  ; than left behind for an unrelated JOIN to answer.
  .timerbridgejoin 1 8 bridge_join_timeout
  if ($3) join $2 $3
  else join $2
}

alias -l bridge_join_failed {
  ; $1 = numeric, $2- = server text
  if (!$var(%bridge_join_id)) return
  if ($cid != %bridge_join_cid) return
  var %id = %bridge_join_id
  .timerbridgejoin off
  unset %bridge_join_id %bridge_join_chan %bridge_join_cid
  bridge_fail %id $1 $2-
}

alias bridge_join_timeout {
  if (!$var(%bridge_join_id)) return
  var %id = %bridge_join_id
  unset %bridge_join_id %bridge_join_chan %bridge_join_cid
  bridge_fail %id 0 join-timeout
}

; Answered when the server echoes our PART, not when /part is issued. Replying
; at once let a join sent straight after it find us still in the channel and
; answer `already: true` without joining.
alias -l bridge_do_part {
  if (!$chan($2)) { bridge_fail $1 0 not-on-channel | return }
  set -e %bridge_part_id $1
  set -e %bridge_part_chan $2
  set -e %bridge_part_cid $cid
  .timerbridgepart 1 8 bridge_part_timeout
  part $2
}

alias bridge_part_timeout {
  if (!$var(%bridge_part_id)) return
  var %id = %bridge_part_id
  unset %bridge_part_id %bridge_part_chan %bridge_part_cid
  bridge_fail %id 0 part-timeout
}

; --- speaking -------------------------------------------------------------

alias -l bridge_do_msg {
  if (!$2) { bridge_fail $1 0 missing-target | return }
  msg $2 $3-
  bridge_ok $1
}

alias -l bridge_do_notice {
  if (!$2) { bridge_fail $1 0 missing-target | return }
  notice $2 $3-
  bridge_ok $1
}

alias -l bridge_do_echo {
  echo -a $2-
  bridge_ok $1
}

; --- connect / raw --------------------------------------------------------

; $1 = id, $2 = server, $3 = port (0 for default), $4 = 1 to reconnect the
; current window, $5 = 1 for TLS, $6- = password
;
; TLS is mIRC's own notation: a + before the port (/server host +6697), with
; 6697 as the default TLS port.
;
; Normally a NEW connection: /server -m opens another connection window. Plain
; /server reuses the current window, which disconnected whatever the user was
; on, so it is used only when the daemon names a window to reuse: a quit window
; for the same network, the agent's own or the user's (mIRC keeps the window,
; and opening a new one each time piled them up). The daemon only ever names a
; disconnected window, and this refuses anything still connected regardless.
; The new connection's id is found by comparing the connection list before and
; after, which works whichever window /server -m leaves active.
alias -l bridge_do_connect {
  if (!$2) { bridge_fail $1 0 missing-server | return }
  var %port = $iif($3, $3, $iif($5 == 1, 6697, 6667))
  if ($5 == 1) %port = + $+ %port
  if ($4 == 1) {
    if ($status != disconnected) { bridge_fail $1 0 connection-busy | return }
    set -e %bridge_conn_id $1
    set -e %bridge_conn_cid $cid
    if ($6- != $null) server $2 %port $6-
    else server $2 %port
    return
  }
  var %before = $bridge_cids
  if ($6- != $null) server -m $2 %port $6-
  else server -m $2 %port
  var %new, %i = 1
  while (%i <= $scon(0)) {
    if (!$istok(%before, $scon(%i), 32)) { %new = $scon(%i) | break }
    inc %i
  }
  if (%new == $null) { bridge_fail $1 0 no-new-connection | return }
  ; A refusal arrives as that connection's DISCONNECT; a silent stall times out
  ; on the daemon.
  set -e %bridge_conn_id $1
  set -e %bridge_conn_cid %new
}

; $1 = id, $2 = the new nick. Answered by our own NICK event on this
; connection, or by the server's refusal: 432 invalid, 433 in use, 437 held
; by the network, 438 changing too fast.
alias -l bridge_do_nick {
  if ($2 == $null) { bridge_fail $1 0 missing-nick | return }
  set -e %bridge_nick_id $1
  set -e %bridge_nick_cid $cid
  .timerbridgenick 1 8 bridge_nick_timeout
  nick $2
}

alias -l bridge_nick_failed {
  ; $1 = numeric, $2- = server text
  if (!$var(%bridge_nick_id)) return
  if ($cid != %bridge_nick_cid) return
  var %id = %bridge_nick_id
  .timerbridgenick off
  unset %bridge_nick_id %bridge_nick_cid
  bridge_fail %id $1 $2-
}

alias bridge_nick_timeout {
  if (!$var(%bridge_nick_id)) return
  var %id = %bridge_nick_id
  unset %bridge_nick_id %bridge_nick_cid
  bridge_fail %id 0 nick-timeout
}

; $1 = id, $2- = quit message. With no message, plain /quit uses mIRC's own
; default: nothing that reaches IRC may mark this as automated. Answered by
; this connection's DISCONNECT. The window stays, as it does when a person
; quits; mIRC or the user can close it.
alias -l bridge_do_disconnect {
  if ($status == disconnected) { bridge_ok $1 $kvo(already, true) | return }
  ; Still connecting or retrying: nothing to quit from, so cancel the attempt.
  ; No DISCONNECT is certain to follow, so answer now; the daemon re-reads
  ; the state afterwards.
  if ($status != connected) { disconnect | bridge_ok $1 $kvo(cancelled, true) | return }
  set -e %bridge_quit_id $1
  set -e %bridge_quit_cid $cid
  .timerbridgequit 1 12 bridge_quit_timeout
  if ($2- != $null) quit $2-
  else quit
}

alias bridge_quit_timeout {
  if (!$var(%bridge_quit_id)) return
  var %id = %bridge_quit_id
  unset %bridge_quit_id %bridge_quit_cid
  bridge_fail %id 0 disconnect-timeout
}

; $1 = id, $2 = the sender's nick. Closing mIRC's DCC get window(s) from that
; nick aborts the transfer, which is how xdcc_cancel stops a download already
; under way. mIRC then reports GETFAIL for it; the daemon files that under the
; job it has just cancelled.
; Verified live (2026-10-22): /close -g <nick> aborts a running get, and mIRC
; reports GETFAIL for it before this command's reply goes out.
alias -l bridge_do_dccstop {
  if ($2 == $null) { bridge_fail $1 0 missing-nick | return }
  close -g $2
  bridge_ok $1
}

alias -l bridge_do_raw {
  if (!$2-) { bridge_fail $1 0 missing-line | return }
  raw $2-
  bridge_ok $1
}

; --- outcome events -------------------------------------------------------

; Only the connection a pending connect opened may answer it. Every other
; connection's CONNECT and DISCONNECT is just an event.
on *:CONNECT: {
  if ($sock(bridge)) bridge_send $evp(conn) $+ $chr(44) $+ $kvo(extra, $chr(123) $+ $kvo(event, $jstr(connected)) $+ $chr(125)) $+ $chr(125)
  if ($var(%bridge_conn_id) && $cid == %bridge_conn_cid) {
    var %id = %bridge_conn_id
    unset %bridge_conn_id %bridge_conn_cid
    bridge_ok %id $kvo(cid, $cid)
  }
}

; A connection attempt that fails before it registers (timed out, refused,
; unresolvable) fires neither CONNECT nor DISCONNECT. In the live test mIRC
; printed "Unable to connect to server (Connection timed out)" four times while
; the daemon heard nothing until its 60 s timeout. $1- is mIRC's reason.
; mIRC goes on retrying by itself; the agent can stop it with irc_disconnect.
; NOT WORKING in mIRC 7.85 (2026-10-22): it fired for none of ten instant TLS
; failures ("SSL certificate verify failed") nor for connection timeouts. Kept
; because it is harmless if it never fires; a failed connect therefore still
; ends in the daemon's 60 s timeout, whose hint names the window to stop.
on *:CONNECTFAIL: {
  if ($sock(bridge)) bridge_send $evp(conn) $+ $chr(44) $+ $kvo(extra, $chr(123) $+ $kvo(event, $jstr(connect_failed)) $+ $chr(44) $+ $kvo(reason, $jstr($1-)) $+ $chr(125)) $+ $chr(125)
  if ($var(%bridge_conn_id) && $cid == %bridge_conn_cid) {
    var %id = %bridge_conn_id
    unset %bridge_conn_id %bridge_conn_cid
    bridge_fail %id 0 $1-
  }
}

on *:DISCONNECT: {
  if ($sock(bridge)) bridge_send $evp(conn) $+ $chr(44) $+ $kvo(extra, $chr(123) $+ $kvo(event, $jstr(disconnected)) $+ $chr(125)) $+ $chr(125)
  if ($var(%bridge_conn_id) && $cid == %bridge_conn_cid) {
    var %id = %bridge_conn_id
    unset %bridge_conn_id %bridge_conn_cid
    bridge_fail %id 0 connection-failed
  }
  if ($var(%bridge_quit_id) && $cid == %bridge_quit_cid) {
    var %id = %bridge_quit_id
    .timerbridgequit off
    unset %bridge_quit_id %bridge_quit_cid
    bridge_ok %id
  }
}

on *:JOIN:#: {
  ; The join is not answered here: mIRC fires JOIN before the server has sent
  ; the member list, so $nick($chan, 0) is 1 (just us) and every fresh join
  ; was reported as a near-empty channel. raw 366 answers it instead.
  if ($sock(bridge)) bridge_send $evp(join) $+ $chr(44) $+ $kvo(buf, $jstr($chan)) $+ $chr(44) $+ $kvo(nick, $jstr($nick)) $+ $chr(125)
}

; End of NAMES: :server 366 me #chan :End of /NAMES list. The member list is
; complete now, so this is where a pending join is answered. It arrived 2 ms
; after JOIN on EFNet. A redirected join never matches and falls to the timer.
;
; The condition is deliberately positive. `!$var(...) || !$istok(...)` was
; rejected by mIRC 7.85 with "/if: invalid format", which aborted the handler
; and left every join to time out. `$var(...) && $istok(...)` is the form the
; old JOIN handler used and is known to parse.
raw 366:*:{
  bridge_mirror_raw $numeric $1-
  if ($var(%bridge_join_id) && $cid == %bridge_join_cid && $istok(%bridge_join_chan, $2, 32)) {
    var %id = %bridge_join_id
    .timerbridgejoin off
    unset %bridge_join_id %bridge_join_chan %bridge_join_cid
    bridge_ok %id $kvo(joined, $jstr($2)) $+ $chr(44) $+ $kvo(members, $nick($2, 0))
  }
}

; The refusals IRC actually reports: 403 no such channel, 405 too many channels,
; 437 temporarily unavailable, 471 full, 473 invite-only, 474 banned, 475 key,
; 477 registered nick required, 489 TLS-only. Anything else is caught by the
; join timer. These only act while a join is pending. 432, 433, 437 and 438
; also refuse a nick change, and only act while one is pending.
;
; Every specific raw handler also mirrors its line. Only the FIRST matching
; raw event in a script file fires, so a numeric with its own handler never
; reaches `raw *:*` below -- the refusal an agent most needs to see would
; otherwise be the one it never gets.
raw 403:*:{ bridge_mirror_raw $numeric $1- | bridge_join_failed 403 $2- }
raw 405:*:{ bridge_mirror_raw $numeric $1- | bridge_join_failed 405 $2- }
raw 437:*:{ bridge_mirror_raw $numeric $1- | bridge_join_failed 437 $2- | bridge_nick_failed 437 $2- }
raw 432:*:{ bridge_mirror_raw $numeric $1- | bridge_nick_failed 432 $2- }
raw 433:*:{ bridge_mirror_raw $numeric $1- | bridge_nick_failed 433 $2- }
raw 438:*:{ bridge_mirror_raw $numeric $1- | bridge_nick_failed 438 $2- }
raw 489:*:{ bridge_mirror_raw $numeric $1- | bridge_join_failed 489 $2- }
raw 471:*:{ bridge_mirror_raw $numeric $1- | bridge_join_failed 471 $2- }
raw 473:*:{ bridge_mirror_raw $numeric $1- | bridge_join_failed 473 $2- }
raw 474:*:{ bridge_mirror_raw $numeric $1- | bridge_join_failed 474 $2- }
raw 475:*:{ bridge_mirror_raw $numeric $1- | bridge_join_failed 475 $2- }
raw 477:*:{ bridge_mirror_raw $numeric $1- | bridge_join_failed 477 $2- }

; ISON reply: :server 303 me :nick1 nick2
raw 303:*:{
  bridge_mirror_raw $numeric $1-
  if (!$var(%bridge_ison_id)) return
  if ($cid != %bridge_ison_cid) return
  var %id = %bridge_ison_id, %asked = %bridge_ison_list, %out
  .timerbridgeison off
  unset %bridge_ison_id %bridge_ison_list %bridge_ison_cid
  var %present = $remove($2-, $chr(58)), %i = 1
  while (%i <= $numtok(%asked, 32)) {
    var %n = $gettok(%asked, %i, 32)
    if ($istok(%present, %n, 32)) {
      if (%out) %out = %out $+ $chr(44)
      %out = %out $+ $jstr(%n)
    }
    inc %i
  }
  bridge_ok %id $kvo(present, $chr(91) $+ %out $+ $chr(93))
}

; --- IRC -> daemon: the mirror -------------------------------------------

raw *:*: { bridge_mirror_raw $numeric $1- }

; $1 = the numeric, $2- = what mIRC gives a raw event as $1-: the parameters,
; starting with our nick, with no server prefix and no colon before the last
; one. mIRC keeps the numeric apart in $numeric, so without passing it along a
; 401 "no such nick" arrived as "me nobody No such nick" -- no way to tell
; which reply it was. The line becomes "401 me nobody No such nick", and the
; numeric is also sent on its own in extra.numeric, so nobody has to parse it.
alias -l bridge_mirror_raw {
  if (!$sock(bridge)) return
  if ($len($1-) > 3000) return
  bridge_send $evp(raw) $+ $chr(44) $+ $kvo(raw, $jstr($1-)) $+ $chr(44) $+ $kvo(extra, $chr(123) $+ $kvo(numeric, $iif($1 isnum, $1, 0)) $+ $chr(125)) $+ $chr(125)
}

; For a private message $target is our own nick, so the buffer is named after
; the sender instead -- the query window mIRC itself would show it in.
alias -l bridge_buf { return $iif($target == $me, $nick, $target) }

on *:TEXT:*:*: {
  if (!$sock(bridge)) return
  if ($len($1-) > 3000) return
  bridge_send $evp(text) $+ $chr(44) $+ $kvo(buf, $jstr($bridge_buf)) $+ $chr(44) $+ $kvo(nick, $jstr($nick)) $+ $chr(44) $+ $kvo(user, $jstr($address)) $+ $chr(44) $+ $kvo(text, $jstr($1-)) $+ $chr(125)
}

on *:NOTICE:*:*: {
  if (!$sock(bridge)) return
  if ($len($1-) > 3000) return
  bridge_send $evp(notice) $+ $chr(44) $+ $kvo(buf, $jstr($bridge_buf)) $+ $chr(44) $+ $kvo(nick, $jstr($nick)) $+ $chr(44) $+ $kvo(user, $jstr($address)) $+ $chr(44) $+ $kvo(text, $jstr($1-)) $+ $chr(125)
}

; CTCP events are written with the ctcp keyword, like raw: ctcp <level>:<match>:
; <*|#|?>. This was "on *:CTCP:*:*:", which mIRC never fires; in 1,333 mirrored
; frames not one CTCP arrived, the DCC SEND offer included. No halt, so mIRC
; still answers VERSION and PING, and still handles DCC itself.
; Verified live (2026-10-22): a DCC SEND offer reaches this handler, with "DCC"
; as $1 and "SEND <file> <ip> <port> <size>" as $2-.
ctcp *:*:*: {
  if (!$sock(bridge)) return
  bridge_send $evp(ctcp) $+ $chr(44) $+ $kvo(nick, $jstr($nick)) $+ $chr(44) $+ $kvo(extra, $chr(123) $+ $kvo(ctcp, $jstr($1)) $+ $chr(44) $+ $kvo(text, $jstr($2-)) $+ $chr(125)) $+ $chr(125)
}

; Our own nick changing is its own event, so the daemon can correct its model.
on me:*:NICK: {
  if (!$sock(bridge)) return
  bridge_send $evp(selfnick) $+ $chr(44) $+ $kvo(extra, $chr(123) $+ $kvo(old, $jstr($nick)) $+ $chr(44) $+ $kvo(new, $jstr($newnick)) $+ $chr(125)) $+ $chr(125)
  if ($var(%bridge_nick_id) && $cid == %bridge_nick_cid) {
    var %id = %bridge_nick_id
    .timerbridgenick off
    unset %bridge_nick_id %bridge_nick_cid
    bridge_ok %id $kvo(nick, $jstr($newnick))
  }
}

on *:NICK: {
  if (!$sock(bridge)) return
  if ($nick == $me) return
  bridge_send $evp(nick) $+ $chr(44) $+ $kvo(nick, $jstr($nick)) $+ $chr(44) $+ $kvo(extra, $chr(123) $+ $kvo(old, $jstr($nick)) $+ $chr(44) $+ $kvo(new, $jstr($newnick)) $+ $chr(125)) $+ $chr(125)
}

on *:PART:#: {
  ; Same positive && form as raw 366, which mIRC is known to parse.
  if ($nick == $me && $var(%bridge_part_id) && $cid == %bridge_part_cid && $istok(%bridge_part_chan, $chan, 32)) {
    var %id = %bridge_part_id
    .timerbridgepart off
    unset %bridge_part_id %bridge_part_chan %bridge_part_cid
    bridge_ok %id $kvo(parted, $jstr($chan))
  }
  if (!$sock(bridge)) return
  bridge_send $evp(part) $+ $chr(44) $+ $kvo(buf, $jstr($chan)) $+ $chr(44) $+ $kvo(nick, $jstr($nick)) $+ $chr(44) $+ $kvo(text, $jstr($1-)) $+ $chr(125)
}

on *:QUIT: {
  if (!$sock(bridge)) return
  bridge_send $evp(quit) $+ $chr(44) $+ $kvo(nick, $jstr($nick)) $+ $chr(44) $+ $kvo(text, $jstr($1-)) $+ $chr(125)
}

on *:KICK:#: {
  if (!$sock(bridge)) return
  bridge_send $evp(kick) $+ $chr(44) $+ $kvo(buf, $jstr($chan)) $+ $chr(44) $+ $kvo(nick, $jstr($knick)) $+ $chr(44) $+ $kvo(text, $jstr($1-)) $+ $chr(125)
}

on *:TOPIC:#: {
  if (!$sock(bridge)) return
  bridge_send $evp(topic) $+ $chr(44) $+ $kvo(buf, $jstr($chan)) $+ $chr(44) $+ $kvo(nick, $jstr($nick)) $+ $chr(44) $+ $kvo(text, $jstr($1-)) $+ $chr(125)
}

; --- DCC outcomes only ----------------------------------------------------
; Progress is deliberately not reported: mIRC already shows it, and the daemon
; only needs to know whether a transfer finished or stopped.
; Verified live (2026-10-22): $filename is the FULL saved path, $nick the sender,
; and $cid the connection the transfer came in on. mIRC gives no failure reason.
;
; Both events take a filename match field (on <level>:GETFAIL:<file>:). They
; were written without it, as "on *:GETFAIL:", which mIRC never fires: a get
; that failed live ("connection failed") produced nothing at all.

on *:FILERCVD:*: {
  if (!$sock(bridge)) return
  bridge_send $evp(dcc) $+ $chr(44) $+ $kvo(extra, $chr(123) $+ $kvo(event, $jstr(complete)) $+ $chr(44) $+ $kvo(file, $jstr($filename)) $+ $chr(44) $+ $kvo(from, $jstr($nick)) $+ $chr(125)) $+ $chr(125)
}

on *:GETFAIL:*: {
  if (!$sock(bridge)) return
  bridge_send $evp(dcc) $+ $chr(44) $+ $kvo(extra, $chr(123) $+ $kvo(event, $jstr(getfail)) $+ $chr(44) $+ $kvo(file, $jstr($filename)) $+ $chr(44) $+ $kvo(from, $jstr($nick)) $+ $chr(125)) $+ $chr(125)
}
