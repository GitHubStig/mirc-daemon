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
alias -l jstr {
  var %s = $replace($1-, $chr(92), $chr(92) $+ $chr(92))
  %s = $replace(%s, $chr(34), $chr(92) $+ $chr(34))
  %s = $replace(%s, $chr(10), $chr(92) $+ n)
  %s = $replace(%s, $chr(13), $chr(92) $+ r)
  %s = $replace(%s, $chr(9), $chr(92) $+ t)
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

alias -l jval {
  var %pat = / $+ $chr(34) $+ $2 $+ $chr(34) $+ $chr(58) $+ $chr(34) $+ ([^ $+ $chr(34) $+ ]*) $+ $chr(34) $+ /
  if ($regex($1, %pat)) return $regml(1)
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
  bridge_connect
  .timerbridgeconn 1 10 bridge_connect
}

alias bridge.stop {
  .timerbridgeconn off
  if ($sock(bridge)) sockclose bridge
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
  return $chr(123) $+ $kvo(t, $jstr(hello)) $+ $chr(44) $+ $kvo(v, 1) $+ $chr(44) $+ $kvo(token, $jstr($1)) $+ $chr(44) $+ $kvo(nick, $jstr($me)) $+ $chr(44) $+ $kvo(mirc, $jstr($version)) $+ $chr(125)
}

alias -l bridge_connect {
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
  if ($sockerr) return
  ; Identify first; the daemon answers `welcome` and then asks for state.
  bridge_send $bridge_helloframe($bridge_token)
}

on *:SOCKCLOSE:bridge: { .timer 1 5 bridge_connect }

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
      set %bridge_last %line
      bridge_dispatch %line
    }
  }
}

alias -l bridge_dispatch {
  var %t = $jval($1-, t)
  ; An unparseable frame used to vanish silently; make it visible instead.
  if (%t == $null) { echo -a * bridge: unparsed frame: $1- | return }
  if (%t == ping) { bridge_send $chr(123) $+ $kvo(t, $jstr(pong)) $+ $chr(125) | return }
  if (%t == cmd) {
    ; Temporary instrumentation: shows whether the frame was understood.
    echo -a * bridge: rx cmd id= $+ $jval($1-, id) $+ action= $+ $jval($1-, action)
    bridge_command $jval($1-, id) $jval($1-, action) $1-
  }
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
  if (%act == members) { bridge_do_members %id $jval(%f, channel) | return }
  if (%act == ison) { bridge_do_ison %id %f | return }
  if (%act == join) { bridge_do_join %id $jval(%f, channel) $jval(%f, key) | return }
  if (%act == part) { bridge_do_part %id $jval(%f, channel) | return }
  if (%act == msg) { bridge_do_msg %id $jval(%f, target) $jval(%f, text) | return }
  if (%act == notice) { bridge_do_notice %id $jval(%f, target) $jval(%f, text) | return }
  if (%act == echo) { bridge_do_echo %id $jval(%f, text) | return }
  if (%act == connect) { bridge_do_connect %id $jval(%f, server) $jnum(%f, port) | return }
  if (%act == raw) { bridge_do_raw %id $jval(%f, line) | return }
  if (%act == quit) { bridge_ok %id | quit | return }
  bridge_fail %id 0 unknown-action-$+(%act)
}

; --- state ----------------------------------------------------------------
; VERIFY: this reports the active connection only. Enumerating every connection
; needs /scon -r per connection, which is deferred until it is exercised.

; The payload is separate from the send so the diagnostic can show it.
alias -l bridge_statepayload {
  var %names, %counts, %i = 1
  while (%i <= $chan(0)) {
    if (%i > 1) %names = %names $+ $chr(44)
    %names = %names $+ $jstr($chan(%i))
    if (%i > 1) %counts = %counts $+ $chr(44)
    %counts = %counts $+ $jstr($chan(%i)) $+ $chr(58) $+ $nick($chan(%i), 0)
    inc %i
  }
  var %net = $chr(123) $+ $kvo(name, $jstr($bridge_net)) $+ $chr(44) $+ $kvo(status, $jstr(connected)) $+ $chr(44) $+ $kvo(nick, $jstr($me)) $+ $chr(44) $+ $kvo(channels, $chr(91) $+ %names $+ $chr(93)) $+ $chr(44) $+ $kvo(members, $chr(123) $+ %counts $+ $chr(125)) $+ $chr(125)
  return $kvo(networks, $chr(91) $+ %net $+ $chr(93))
}

alias -l bridge_do_state {
  bridge_ok $1 $bridge_statepayload
}

alias -l bridge_do_members {
  var %ch = $2, %names, %i = 1
  while (%i <= $nick(%ch, 0)) {
    if (%i > 1) %names = %names $+ $chr(44)
    %names = %names $+ $jstr($nick(%ch, %i))
    inc %i
  }
  bridge_ok $1 $kvo(count, $nick(%ch, 0)) $+ $chr(44) $+ $kvo(names, $chr(91) $+ %names $+ $chr(93))
}

alias -l bridge_do_ison {
  var %list = $mid($2, $pos($2, $chr(91)) + 1)
  %list = $left(%list, $pos(%list, $chr(93)) - 1)
  %list = $replace(%list, $chr(34), $null, $chr(44), $chr(32))
  ; Deliberately not `set -u`: these must survive until the 303 arrives.
  set %bridge_ison_id $1
  set %bridge_ison_list %list
  .timerbridgeison 1 10 bridge_ison_timeout
  ison %list
}

alias -l bridge_ison_timeout {
  if (!$var(%bridge_ison_id)) return
  var %id = %bridge_ison_id
  .timerbridgeison off
  unset %bridge_ison_id %bridge_ison_list
  bridge_fail %id 0 ison-timeout
}

; --- join / part ----------------------------------------------------------

alias -l bridge_do_join {
  set %bridge_join_id $1
  set %bridge_join_chan $2
  if ($3) join $2 $3
  else join $2
}

alias -l bridge_join_failed {
  ; $1 = numeric, $2- = server text
  if (!$var(%bridge_join_id)) return
  var %id = %bridge_join_id
  unset %bridge_join_id %bridge_join_chan
  bridge_fail %id $1 $2-
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

alias -l bridge_do_connect {
  if (!$2) { bridge_fail $1 0 missing-server | return }
  ; A refusal arrives as a DISCONNECT; a silent stall times out on the daemon.
  set %bridge_conn_id $1
  if ($3) server $2 $3
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
    var %id = %bridge_conn_id
    unset %bridge_conn_id
    bridge_fail %id 0 connection-failed
  }
}

on *:JOIN:#: {
  if ($nick == $me && $var(%bridge_join_id) && $istok(%bridge_join_chan, $chan, 32)) {
    var %id = %bridge_join_id
    unset %bridge_join_id %bridge_join_chan
    bridge_ok %id $kvo(joined, $jstr($chan)) $+ $chr(44) $+ $kvo(members, $nick($chan, 0))
  }
  if ($sock(bridge)) bridge_send $evp(join) $+ $chr(44) $+ $kvo(buf, $jstr($chan)) $+ $chr(44) $+ $kvo(nick, $jstr($nick)) $+ $chr(125)
}

; The refusals IRC actually reports: 403 no such channel, 471 full, 473
; invite-only, 474 banned, 475 key, 477 registered nick required.
raw 403:*:{ bridge_join_failed 403 $2- }
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

on *:TEXT:*:*: {
  if (!$sock(bridge)) return
  if ($len($1-) > 3000) return
  bridge_send $evp(text) $+ $chr(44) $+ $kvo(buf, $jstr($target)) $+ $chr(44) $+ $kvo(nick, $jstr($nick)) $+ $chr(44) $+ $kvo(user, $jstr($address)) $+ $chr(44) $+ $kvo(text, $jstr($1-)) $+ $chr(125)
}

on *:NOTICE:*:*: {
  if (!$sock(bridge)) return
  if ($len($1-) > 3000) return
  bridge_send $evp(notice) $+ $chr(44) $+ $kvo(buf, $jstr($target)) $+ $chr(44) $+ $kvo(nick, $jstr($nick)) $+ $chr(44) $+ $kvo(user, $jstr($address)) $+ $chr(44) $+ $kvo(text, $jstr($1-)) $+ $chr(125)
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
