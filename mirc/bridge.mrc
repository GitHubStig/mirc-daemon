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

; The active connection's network name, falling back to the server address.
alias -l bridge_net { return $iif($network, $network, $server) }

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

; Prefix shared by every event frame: {"t":"ev","kind":"...","net":"..."
alias -l evp {
  return $chr(123) $+ $kvo(t, $jstr(ev)) $+ $chr(44) $+ $kvo(kind, $jstr($1)) $+ $chr(44) $+ $kvo(net, $jstr($bridge_net))
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

; A command param: base64 on the wire (protocol v2), decoded here.
; Decoded through a binary variable so the bytes are read back as UTF-8 text
; rather than one character per byte. The daemon has already turned line
; breaks into spaces, so the result is always safe to hand to /msg.
; VERIFY: $bvar().text decodes UTF-8 -- /bridge.diag's b64-test checks it.
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
  echo -a * bridge: stopped
}

; Diagnostic you can run from the editbox; deliberately never prints the token.
alias bridge.diag {
  echo -a * bridge: inifile = $bridge_inifile
  echo -a * bridge: host = $bridge_host port = $bridge_port token = $iif($bridge_token, set, MISSING)
  echo -a * bridge: socket = $iif($sock(bridge), $sock(bridge), not-open)
  echo -a * bridge: mircdir = $mircdir
  echo -a * bridge: hello = $bridge_helloframe(***)
  echo -a * bridge: last-in = $iif(%bridge_last, %bridge_last, nothing received yet)
  echo -a * bridge: state = $bridge_statepayload
  ; Self-test for the inbound reader, using the same builders as a real frame.
  var %probe = $chr(123) $+ $kvo(t, $jstr(cmd)) $+ $chr(44) $+ $kvo(id, $jstr(c1)) $+ $chr(44) $+ $kvo(action, $jstr(state)) $+ $chr(125)
  echo -a * bridge: jval-test t= $+ $jval(%probe, t) $+ id= $+ $jval(%probe, id) $+ action= $+ $jval(%probe, action)
  ; The param decoder, run inside mIRC itself. The vector is the daemon's
  ; encoding of: say "hi" C:\dir u-umlaut ^B b -- a quote pair, a backslash,
  ; a non-ASCII letter and an IRC bold code, each of which broke a reader once.
  var %frame = $chr(123) $+ $kvo(text, $jstr(c2F5ICJoaSIgQzpcZGlyIMO8AmI=)) $+ $chr(125)
  var %want = say $chr(34) $+ hi $+ $chr(34) C:\dir $chr(252) $+ $chr(2) $+ b
  var %got = $jparam(%frame, text)
  echo -a * bridge: b64-test $iif(%got === %want, ok, FAILED got= $+ %got)
}

; Sends a known frame straight down the socket, bypassing everything else.
; If this shows up in the daemon log, writing works and the fault is earlier.
alias bridge.test {
  if (!$sock(bridge)) { echo -a * bridge: socket is not open, cannot write | return }
  bridge_send $chr(123) $+ $kvo(t, $jstr(pong)) $+ $chr(125)
  echo -a * bridge: sent test frame, sockerr = $sock(bridge).wserr
}

; Built in one place so the diagnostic can show exactly what would be sent.
; $1 = token, so the diagnostic can pass a mask instead.
alias -l bridge_helloframe {
  return $chr(123) $+ $kvo(t, $jstr(hello)) $+ $chr(44) $+ $kvo(v, 2) $+ $chr(44) $+ $kvo(token, $jstr($1)) $+ $chr(44) $+ $kvo(nick, $jstr($me)) $+ $chr(44) $+ $kvo(mirc, $jstr($version)) $+ $chr(125)
}

; Not -l: it is run from a timer, and whether a timer may call a local alias is
; not something to bet the reconnect loop on. The same applies to every
; *_timeout alias below.
alias bridge_connect {
  ; A missing or unreadable bridge.ini otherwise surfaces as "sockopen:
  ; insufficient parameters", which says nothing useful. Say what is wrong.
  if (!$bridge_host || !$bridge_port || !$bridge_token) {
    echo -a * bridge: cannot read host/port/token from $bridge_inifile
    echo -a * bridge: copy bridge.ini next to bridge.mrc, with [bridge] host/port/token
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
  if (%bridge_down) { echo -a * bridge: reconnected to the daemon | unset %bridge_down }
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
  echo -a * bridge: $1-
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
  if (%t == $null) { echo -a * bridge: unparsed frame: $1- | return }
  if (%t == ping) { bridge_send $chr(123) $+ $kvo(t, $jstr(pong)) $+ $chr(125) | return }
  ; The daemon refused us (e.g. a protocol mismatch). Say why and stop
  ; retrying, rather than reconnecting every few seconds to be refused again.
  ; The reason is daemon-written plain ASCII, so jval reads it as-is.
  if (%t == bye) { echo -a * bridge: daemon refused: $jval($1-, reason) | bridge.stop | return }
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

alias -l bridge_command {
  var %id = $1, %act = $2, %f = $3-
  if (%act == state) { bridge_do_state %id | return }
  if (%act == members) { bridge_do_members %id $jparam(%f, channel) $jparam(%f, nick) | return }
  if (%act == ison) { bridge_do_ison %id $jparam(%f, list) | return }
  if (%act == join) { bridge_do_join %id $jparam(%f, channel) $jparam(%f, key) | return }
  if (%act == part) { bridge_do_part %id $jparam(%f, channel) | return }
  if (%act == msg) { bridge_do_msg %id $jparam(%f, target) $jparam(%f, text) | return }
  if (%act == notice) { bridge_do_notice %id $jparam(%f, target) $jparam(%f, text) | return }
  if (%act == echo) { bridge_do_echo %id $jparam(%f, text) | return }
  ; Port is always passed (0 for none) so a password cannot shift into its slot.
  ; Numbers are not encoded, so the port is read with jnum.
  if (%act == connect) { bridge_do_connect %id $jparam(%f, server) $iif($jnum(%f, port), $v1, 0) $jparam(%f, password) | return }
  if (%act == raw) { bridge_do_raw %id $jparam(%f, line) | return }
  if (%act == quit) { bridge_ok %id | quit | return }
  bridge_fail %id 0 unknown-action-$+(%act)
}

; --- state ----------------------------------------------------------------
; VERIFY: this reports the active connection only. Enumerating every connection
; needs /scon -r per connection, which is deferred until it is exercised.

; The payload is separate from the send so the diagnostic can show it.
alias -l bridge_statepayload {
  ; No network and no server means the active window is not attached to
  ; anything; reporting a nameless "connected" network would let the daemon
  ; think it could send.
  if ($bridge_net == $null) return $kvo(networks, $chr(91) $+ $chr(93))
  ; $status also has "loggingon", which is still connecting as far as an agent
  ; is concerned. This used to be hard-coded to "connected".
  var %st = $iif($status == connected, connected, $iif($status == disconnected, disconnected, connecting))
  var %names, %counts, %i = 1
  while (%i <= $chan(0)) {
    if (%i > 1) %names = %names $+ $chr(44)
    %names = %names $+ $jstr($chan(%i))
    if (%i > 1) %counts = %counts $+ $chr(44)
    %counts = %counts $+ $jstr($chan(%i)) $+ $chr(58) $+ $nick($chan(%i), 0)
    inc %i
  }
  var %net = $chr(123) $+ $kvo(name, $jstr($bridge_net)) $+ $chr(44) $+ $kvo(status, $jstr(%st)) $+ $chr(44) $+ $kvo(nick, $jstr($me)) $+ $chr(44) $+ $kvo(channels, $chr(91) $+ %names $+ $chr(93)) $+ $chr(44) $+ $kvo(members, $chr(123) $+ %counts $+ $chr(125)) $+ $chr(125)
  return $kvo(networks, $chr(91) $+ %net $+ $chr(93))
}

alias -l bridge_do_state {
  bridge_ok $1 $bridge_statepayload
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
  ; Deliberately not `set -u`: these must survive until the 303 arrives.
  set %bridge_ison_id $1
  set %bridge_ison_list %list
  .timerbridgeison 1 10 bridge_ison_timeout
  ison %list
}

alias bridge_ison_timeout {
  if (!$var(%bridge_ison_id)) return
  var %id = %bridge_ison_id
  .timerbridgeison off
  unset %bridge_ison_id %bridge_ison_list
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
  set %bridge_join_id $1
  set %bridge_join_chan $2
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
  var %id = %bridge_join_id
  .timerbridgejoin off
  unset %bridge_join_id %bridge_join_chan
  bridge_fail %id $1 $2-
}

alias bridge_join_timeout {
  if (!$var(%bridge_join_id)) return
  var %id = %bridge_join_id
  unset %bridge_join_id %bridge_join_chan
  bridge_fail %id 0 join-timeout
}

alias -l bridge_do_part {
  if (!$chan($2)) { bridge_fail $1 0 not-on-channel | return }
  part $2
  bridge_ok $1
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

; $1 = id, $2 = server, $3 = port (0 for default), $4- = password
alias -l bridge_do_connect {
  if (!$2) { bridge_fail $1 0 missing-server | return }
  ; A refusal arrives as a DISCONNECT; a silent stall times out on the daemon.
  set %bridge_conn_id $1
  ; /server reuses the active connection. If that one is live, its own
  ; DISCONNECT fires first, and must not be read as this connect failing.
  ; VERIFY against real mIRC that exactly one DISCONNECT fires in that case.
  if ($status != disconnected) set %bridge_conn_skipdc 1
  else unset %bridge_conn_skipdc
  var %port = $iif($3, $3, 6667)
  if ($4- != $null) server $2 %port $4-
  elseif ($3) server $2 %port
  else server $2
}

alias -l bridge_do_raw {
  if (!$2-) { bridge_fail $1 0 missing-line | return }
  raw $2-
  bridge_ok $1
}

; --- outcome events -------------------------------------------------------

on *:CONNECT: {
  if ($sock(bridge)) bridge_send $evp(conn) $+ $chr(44) $+ $kvo(extra, $chr(123) $+ $kvo(event, $jstr(connected)) $+ $chr(125)) $+ $chr(125)
  if ($var(%bridge_conn_id)) {
    var %id = %bridge_conn_id
    unset %bridge_conn_id
    bridge_ok %id
  }
}

on *:DISCONNECT: {
  if ($sock(bridge)) bridge_send $evp(conn) $+ $chr(44) $+ $kvo(extra, $chr(123) $+ $kvo(event, $jstr(disconnected)) $+ $chr(125)) $+ $chr(125)
  if ($var(%bridge_conn_id)) {
    if (%bridge_conn_skipdc) { unset %bridge_conn_skipdc | return }
    var %id = %bridge_conn_id
    unset %bridge_conn_id
    bridge_fail %id 0 connection-failed
  }
}

on *:JOIN:#: {
  if ($nick == $me && $var(%bridge_join_id) && $istok(%bridge_join_chan, $chan, 32)) {
    var %id = %bridge_join_id
    .timerbridgejoin off
    unset %bridge_join_id %bridge_join_chan
    bridge_ok %id $kvo(joined, $jstr($chan)) $+ $chr(44) $+ $kvo(members, $nick($chan, 0))
  }
  if ($sock(bridge)) bridge_send $evp(join) $+ $chr(44) $+ $kvo(buf, $jstr($chan)) $+ $chr(44) $+ $kvo(nick, $jstr($nick)) $+ $chr(125)
}

; The refusals IRC actually reports: 403 no such channel, 405 too many channels,
; 437 temporarily unavailable, 471 full, 473 invite-only, 474 banned, 475 key,
; 477 registered nick required, 489 TLS-only. Anything else is caught by the
; join timer. These only act while a join is pending.
raw 403:*:{ bridge_join_failed 403 $2- }
raw 405:*:{ bridge_join_failed 405 $2- }
raw 437:*:{ bridge_join_failed 437 $2- }
raw 489:*:{ bridge_join_failed 489 $2- }
raw 471:*:{ bridge_join_failed 471 $2- }
raw 473:*:{ bridge_join_failed 473 $2- }
raw 474:*:{ bridge_join_failed 474 $2- }
raw 475:*:{ bridge_join_failed 475 $2- }
raw 477:*:{ bridge_join_failed 477 $2- }

; ISON reply: :server 303 me :nick1 nick2
raw 303:*:{
  if (!$var(%bridge_ison_id)) return
  var %id = %bridge_ison_id, %asked = %bridge_ison_list, %out
  .timerbridgeison off
  unset %bridge_ison_id %bridge_ison_list
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

raw *:*: {
  if (!$sock(bridge)) return
  if ($len($1-) > 3000) return
  bridge_send $evp(raw) $+ $chr(44) $+ $kvo(raw, $jstr($1-)) $+ $chr(125)
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

on *:CTCP:*:*: {
  if (!$sock(bridge)) return
  bridge_send $evp(ctcp) $+ $chr(44) $+ $kvo(nick, $jstr($nick)) $+ $chr(44) $+ $kvo(extra, $chr(123) $+ $kvo(ctcp, $jstr($1)) $+ $chr(44) $+ $kvo(text, $jstr($2-)) $+ $chr(125)) $+ $chr(125)
}

; Our own nick changing is its own event, so the daemon can correct its model.
on me:*:NICK: {
  if (!$sock(bridge)) return
  bridge_send $evp(selfnick) $+ $chr(44) $+ $kvo(extra, $chr(123) $+ $kvo(old, $jstr($nick)) $+ $chr(44) $+ $kvo(new, $jstr($newnick)) $+ $chr(125)) $+ $chr(125)
}

on *:NICK: {
  if (!$sock(bridge)) return
  if ($nick == $me) return
  bridge_send $evp(nick) $+ $chr(44) $+ $kvo(nick, $jstr($nick)) $+ $chr(44) $+ $kvo(extra, $chr(123) $+ $kvo(old, $jstr($nick)) $+ $chr(44) $+ $kvo(new, $jstr($newnick)) $+ $chr(125)) $+ $chr(125)
}

on *:PART:#: {
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
; VERIFY: which identifiers are populated here is a recon question. $filename
; and $nick are the documented ones, so those are what we send.

on *:FILERCVD: {
  if (!$sock(bridge)) return
  bridge_send $evp(dcc) $+ $chr(44) $+ $kvo(extra, $chr(123) $+ $kvo(event, $jstr(complete)) $+ $chr(44) $+ $kvo(file, $jstr($filename)) $+ $chr(44) $+ $kvo(from, $jstr($nick)) $+ $chr(125)) $+ $chr(125)
}

on *:GETFAIL: {
  if (!$sock(bridge)) return
  bridge_send $evp(dcc) $+ $chr(44) $+ $kvo(extra, $chr(123) $+ $kvo(event, $jstr(getfail)) $+ $chr(44) $+ $kvo(file, $jstr($filename)) $+ $chr(44) $+ $kvo(from, $jstr($nick)) $+ $chr(125)) $+ $chr(125)
}
