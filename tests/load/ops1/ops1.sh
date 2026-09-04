#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

export API_BASE="${API_BASE:-https://ops.acchindra.com}"
export SETUP_WAIT_SECONDS="30"
export DURATION="1m"
export ADMIN_USERNAME="admin"
export ADMIN_PASSWORD="change-me"
export USER_POOL="User01:user01test,User02:user02test,User03:user03test,User04:user04test,User05:user05test,User06:user06test,User07:user07test,User08:user08test,User09:user09test,User10:user10test,User11:user11test,User12:user12test,User13:user13test,User14:user14test,User15:user15test,User16:user16test,User17:user17test,User18:user18test,User19:user19test,User20:user20test,User21:user21test,User22:user22test,User23:user23test,User24:user24test,User25:user25test,User26:user26test,User27:user27test,User28:user28test,User29:user29test,User30:user30test,User31:user31test,User32:user32test,User33:user33test,User34:user34test,User35:user35test,User36:user36test,User37:user37test,User38:user38test,User39:user39test,User40:user40test,User41:user41test,User42:user42test,User43:user43test,User44:user44test,User45:user45test,User46:user46test,User47:user47test,User48:user48test,User49:user49test,User50:user50test,User51:user51test,User52:user52test,User53:user53test,User54:user54test,User55:user55test,User56:user56test,User57:user57test,User58:user58test,User59:user59test,User60:user60test,User61:user61test,User62:user62test,User63:user63test,User64:user64test,User65:user65test,User66:user66test,User67:user67test,User68:user68test,User69:user69test,User70:user70test,User71:user71test,User72:user72test,User73:user73test,User74:user74test,User75:user75test,User76:user76test,User77:user77test,User78:user78test,User79:user79test,User80:user80test,User81:user81test,User82:user82test,User83:user83test,User84:user84test,User85:user85test,User86:user86test,User87:user87test,User88:user88test,User89:user89test,User90:user90test,User91:user91test,User92:user92test,User93:user93test,User94:user94test,User95:user95test,User96:user96test,User97:user97test,User98:user98test,User99:user99test"

k6 run "real-time-ops1-test.js"
