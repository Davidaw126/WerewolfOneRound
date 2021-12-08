var refreshSeatInterval, checkGameRepeatInterval;
var waitDone = 'false';
var isGameStarted = false;
var nextGame = false;
var gloNumSeats = 0;
var gameData;
$(document).ready(async function(){

	buildUp("INITIAL")
	resetCard()
	gameProgressPowerBuild('default')
	refreshSeatInterval = setInterval(refreshSeat,500);
	checkGameRepeatInterval = setInterval(checkGameRepeat, 500)
	setInterval(refreshSeat,500);
	$('.shape').shape();
	$(".shape").click(function(){
			$('.shape').shape("flip over");
	});

	$('.ui.dropdown').dropdown();


	let adminFunction = await checkAdmin()
	let adminButton = document.getElementById("admin")
	console.log(adminFunction)
	if (adminFunction != true){
			adminButton.className += "disabled"
	}


	while(true){

			await until(_ => false != isGameStarted);

			let admin = await checkAdmin()

			if(admin !=true){
				console.log("Game Started Normal User")
				await refreshGame()
			}
			await until(_ => nextGame == true);
			await restartGame(false)

	}



});

function resetCard(){
	let first = document.getElementById('first');
	let second = document.getElementById('second');
	first.className="side active"
	second.className="side"
	$('.shape').shape();
}


function refreshSeat(){
	let formData = {};
	let numberOfSeats = 0
	$.ajax({
	  type: "POST",
	  url: "http://192.168.1.205:5000/seat/refresh",
	  data: formData,
	  dataType: "json",
	  cache: false
	}).done(async function (data) {
		nextGame = data.lockStatus
		gameData = data
		  let roomTitleNumber = document.getElementById('roomTitleNumber');
		  roomTitleNumber.innerHTML = "房间号： " + data.roomNumber
		  numberOfSeats = 0;
		  for (let [key, value] of Object.entries(data.seats)) {
				let box = document.getElementById('name'+key);
				box.innerHTML = value;
			}

		  let roles = document.getElementById('roles');
		  let rolesString = ""
		  for (let [key, value] of Object.entries(data.roomSettings)) {
			  if(value > 0){
			  	rolesString += key + " x " + value + "，";
			  }
		  }
		  roles.innerHTML = "房间配置： " + rolesString.substring(0, rolesString.length - 1);



	});
}

function shuffleCard(){
	let judgeInfoMsg= document.getElementById("judgeInfoMsg");
	let judgeInfoHeader= document.getElementById("judgeInfoHeader");
	judgeInfoHeader.innerHTML = "重新发牌"

	//if(waitDone==false){
			$.ajax({
		  type: "POST",
		  url: "http://192.168.1.205:5000/game/shuffle",
		  dataType: "json",
		  cache: false
		}).done(function (data) {

		});
		judgeInfoMsg.innerHTML="已重新发牌，请告知玩家们"

	$('#judgeInfo').modal('show');

}

function checkAdmin(){
	return  $.ajax({
	  type: "POST",
	  url: "http://192.168.1.205:5000/user/checkAdmin",
	  dataType: "json",
	  cache: false
	}).done(function (data) {

	});
}


function reveal(){
	$.ajax({
	  type: "POST",
	  url: "http://192.168.1.205:5000/game/checkRole",
	  dataType: "json",
	  cache: false
	}).done(function (data) {
		console.log(data)
		resetCard()
		$('#reveal').modal('show');
		let role = document.getElementById('insertRole');
		role.innerHTML = Object.values(data)
	});
}

function takeSeat(id){
	let formData = {};
	formData['seatNumber'] = id
	$.ajax({
	  type: "POST",
	  url: "http://192.168.1.205:5000/seat/take",
	  data: formData,
	  dataType: "json",
	  cache: false
	}).done(function (data) {
	});

}

function buildUp(gate){
	return $.ajax({
	  type: "POST",
	  url: "http://192.168.1.205:5000/seat/refresh",
	  dataType: "json",
	  cache: false
	}).done(function (data) {
		let numberOfSeats = data.numberOfSeats;
		gloNumSeats  = data.numberOfSeats;

		let body = document.getElementById('dynamic_insert');
		body.innerHTML = '';
		for (let [key, value] of Object.entries(data.roomSettings)) {
			if(key == "盗贼"){
				numberOfSeats-=2
			}
		}

		for(let i = numberOfSeats ; i > 0; i--){
			let newdiv = document.createElement('div');   //create a div

			newdiv.id = i;                      //add an id
			newdiv.className = 'ui middle aligned center aligned four wide column'

			let square_button = createSquareButton(gate,i)


			newdiv.appendChild(square_button)
			body.appendChild(newdiv);
			body.insertBefore(newdiv,body.firstChild)
		}


	});

}

function createSquareButton(gate,i){
			let square_button = document.createElement('div');

			if(gate == "LOCK") {
				square_button.setAttribute('onclick', 'select(' + i + ')')
				square_button.className = 'ui link card black basic disabled button squareButton'
			}else if(gate == "INITIAL"){
				square_button.setAttribute('onclick', 'takeSeat(' + i + ')')
				square_button.className = 'ui link card black basic button squareButton'
			}else if(gate == "POWER"){
				square_button.setAttribute('onclick', 'select(' + i + ')')
				square_button.className = 'ui link card orange basic button squareButton'
			}else if(gate == "LOVE"){
				square_button.setAttribute('onclick', 'invert(' + i + ')')
				square_button.className = 'ui link card gray basic button squareButton'
			}else if(gate == "THIEF"){
				let num = gloNumSeats-2+i
				square_button.setAttribute('onclick', 'select(' + num + ')')
				square_button.className = 'ui link card gray basic button squareButton'
			}

			let right_corner =  document.createElement('div');
			right_corner.className = "ui corner black label"
			right_corner.innerHTML = i
			right_corner.id = "corner" + i

			if(gate=='POWER' ){
				right_corner.className =" ui corner orange label"
			} else if(gate == "LOVE"){
				right_corner.className =" ui corner gray label"
			}


			let right_icon = document.createElement('i')
			right_icon.className = "user icon nextline"

			let right_button = document.createElement('div')
			right_button.className ="ui content"



			right_button.appendChild(right_icon)

			let inner_text = document.createElement('div')
			inner_text.id = "name" + i
			inner_text.innerHTML = "Empty"

			if(gate == "THIEF"){
				inner_text.id = "thief" + i
				inner_text.innerHTML = gameData.identities[gloNumSeats-2+i]
			}
			right_button.appendChild(inner_text)

			square_button.appendChild(right_corner)
			square_button.appendChild(right_button)
			return square_button
}

async function startGame(){
	let roomSettingList = []
	$.ajax({
	  type: "POST",
	  url: "http://192.168.1.205:5000/seat/refresh",
	  dataType: "json",
	  cache: false
	}).done(async function (data) {
		  for (let [key, value] of Object.entries(data.roomSettings)) {
			  if(value > 0){
			  	roomSettingList.push(key)
			  }
		  }
		  roomSettingList = Array.from(new Set(roomSettingList))

		  let roomSettingRemove = new Array();
		  let order = ['盗贼','丘比特','野孩子','普通狼人','守卫','预言家','女巫','猎人','狼美人']
		  for(let i = 0; i< roomSettingList.length ;i++){
				if(order.includes(roomSettingList[i])){
					roomSettingRemove.push(roomSettingList[i])
			  	}
				if(roomSettingList[i]=='丘比特'){
					roomSettingRemove.push('情侣')
				}
		  }

		  const sortByObject  = data => data.reduce((obj,item,index) => { return { ...obj, [item]:index } }, {})
		  let orderDict = sortByObject(order) /* {盗贼: 0, 丘比特: 1, 野孩子: 2} */

		  let result = roomSettingRemove.sort((a, b) => orderDict[a] - orderDict[b]);
		  updateGameOrder(result);



		  buildUp("LOCK");
		  restartGame(true);
		  let thiefContain = result.includes("盗贼");

		  let  badList = ["普通狼人","白狼王", "黑狼王", "隐狼", "恶魔", "狼美人", "恶灵骑士", "梦魇", "机械狼"];


		  let stageMusic = new Audio();

		   stageMusic.src = "static/Music/天黑.m4a";
		   stageMusic.play()
		   await sleep(15000)

		  for(let i = 0;i<result.length;i++){
		  	 waitDone = result[i];

			 await game(result[i]);
			  if(thiefContain == true && badList.includes(waitDone) == false && (
			  	 waitDone == gameData.identities[gloNumSeats-1] || waitDone == gameData.identities[gloNumSeats])){
			  	  console.log("被埋了")

				  updateGame("NEXT")
				  buildUp('LOCK')

			  }else{

			  	stageMusic.src = 'static/Mp3/'+waitDone+'.mp3'
		  		stageMusic.play();
				await sleep(30000)

			  	await until(_ => result[i] != waitDone); //check if power is used?

			  }
		  	 console.log("Done one stage")
		  }
		  stageMusic.src = "static/Music/天亮.m4a";
		  stageMusic.play()
		  console.log("Done Game Admin")

	});


}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
async function refreshGame(){
	let currentStage = "";

	do{
		  buildUp("LOCK")
		 currentStage = waitDone;

		 await game(currentStage)
		 await until(_ => currentStage != waitDone);

		 console.log("Done one stage")

	}while(waitDone != false);

	await game(waitDone)
	console.log("Done Game Normal user")

}

async function game(stage) {
		let gameResult = await checkGameResult()


		let stageNow = await checkRoleMatch()

		console.log("Current Stage: " + stageNow)
		gameProgressPowerBuild(stageNow,gameResult)
	return true
}

function checkCardStatus(){
	$.ajax({
	  type: "POST",
	  url: "http://192.168.1.205:5000/game/cardStatus",
	  dataType: "json",
	  cache: false
	}).done(function (data) {
	});
}

function checkCouple(){
	return $.ajax({
	  type: "POST",
	  url: "http://192.168.1.205:5000/game/couple",
	  dataType: "json",
	  cache: false
	}).done(function (data) {
	});
}

function updateGameOrder(stageOrder){
	let formData = {}
	formData['stageOrder'] = JSON.stringify(stageOrder)
	 $.ajax({
	  type: "POST",
	  url: "http://192.168.1.205:5000/game/order",
	  dataType: "json",
	  data: formData,
	  cache: false
	}).done(function (data) {
	});
}


function updateGame(next){
	let formData = {}
	formData['next'] = next
	return $.ajax({
	  type: "POST",
	  url: "http://192.168.1.205:5000/game/update",
	  dataType: "json",
	  data: formData,
	  cache: false
	}).done(function (data) {
	});
}


function checkRoleMatch(){ /* check is role match with currentStage, return  普通狼人/... or NOT READY */

	return $.ajax({
	  type: "POST",
	  url: "http://192.168.1.205:5000/game/checkMatch",
	  dataType: "json",
	  cache: false
	}).done(function (data) {
	});
}

function checkGameRepeat(){ /*check currentStage  return  普通狼人 */
	 $.ajax({
	  type: "POST",
	  url: "http://192.168.1.205:5000/game/checkCurrentStage",
	  dataType: "json",
	  cache: false
	}).done(function (data) {
		waitDone = data
		isGameStarted = data
		 console.log(data)
	});
}

function gameProgressPowerBuild(stage, gameResult){
	let body = document.getElementById('powerSelect');
	let body2 = document.getElementById('powerSelect2');
	let body3 = document.getElementById('powerSelect3');
	body.innerHTML = '';
	body2.innerHTML = '';
	body3.innerHTML = '';

	let powerButton = document.getElementById('powerButton');
	powerButton.setAttribute('onclick', 'confirmPower()')

	let power1 = document.createElement('div');
	power1.className = 'ui toggle checkbox'
	let input1 = document.createElement('input')
	input1.name = 'power1'
	input1.type = 'checkbox'
	let label1 =  document.createElement('label')

	let power2 = document.createElement('div');
	power2.className = 'ui toggle checkbox'
	let input2 = document.createElement('input')
	input2.name = 'power2'
	input2.type = 'checkbox'
	let label2 =  document.createElement('label')

	let removeThiefGrid = document.getElementById("thiefGrid")
	let releasePower = document.getElementById('releasePower')
	if(removeThiefGrid !== null){
		releasePower.removeChild(removeThiefGrid)
	}


	switch(stage){
		case "普通狼人":
			label1.innerHTML = "是否选择猎杀"
			input1.id = "kill"
			break;
		case "预言家":
			label1.innerHTML = "是否选择查验"
			input1.id = "check"
			break;
		case "女巫":
			label1.innerHTML = "是否使用毒药"
			input1.id = "check"
			label2.innerHTML = "是否使用解药"
			input2.id = "check2"

			let label3 =  document.createElement('label')
			label3.innerHTML = ""
			if(gameResult['普通狼人']>0){
				label3.innerHTML = "今夜被猎杀的是"+ gameResult['普通狼人'] + "号玩家"
				input2.disabled = false
			}else{
				label3.innerHTML = "今夜平安夜"
				input2.disabled = true
			}
			body2.innerHTML = '';
			power2.appendChild(input2)
			power2.appendChild(label2)
			body2.appendChild(power2)
			body3.appendChild(label3)
			break;
		case "猎人":
			power1.className = ''
			input1 = document.createElement('div')
			if( gameResult['猎人'] == "True"){
				label1.innerHTML = "开枪状态为 可以开枪"
			}else{
				label1.innerHTML = "开枪状态为 无法开枪"
			}
			break;
		case "守卫":
			label1.innerHTML = "是否选择守护"
			input1.id = "check"
			break;
		case "狼美人":
			label1.innerHTML = "是否选择魅惑"
			input1.id = "check"
			break;
		case "丘比特":
			label1.innerHTML = "是否选择连接情侣"
			input1.id = "check"
			break;
		case "盗贼":
			let grid = document.createElement('div');
			grid.className = "ui center aligned grid "
			grid.id ="thiefGrid"


			let newdiv = document.createElement('div');   //create a div

			newdiv.className = 'ui middle aligned center aligned four wide column thiefMargin'
			let square_button = createSquareButton("THIEF",1)
			let newdiv2 = document.createElement('div');   //create a div
			newdiv2.className = 'ui middle aligned center aligned four wide column thiefMargin'
			let square_button2 = createSquareButton("THIEF",2)

			newdiv.appendChild(square_button)
			newdiv2.appendChild(square_button2)
			grid.appendChild(newdiv)
			grid.appendChild(newdiv2)
			releasePower.appendChild(grid)

			power1.className = ''
			input1 = document.createElement('div')
			label1.innerHTML = "请选择其中一个身份"
			powerButton.setAttribute('onclick', 'closeCheckId()')
			break;
		default:
			power1.className = ''
			input1 = document.createElement('div')
			label1.innerHTML = "不是使用技能的环节"
			break;
	}

	power1.appendChild(input1)
	power1.appendChild(label1)
	body.appendChild(power1)


}
function select(id) {
		if(isGameStarted!=false){
			let formData = {};
		formData['select'] = id
		formData['powerType'] =  isGameStarted
		$.ajax({
			type: "POST",
			url: "http://192.168.1.205:5000/game/select",
			data: formData,
			dataType: "json",
			cache: false
		}).done(function (data) {
			console.log(data)
			if(data == true){
				updateGame("NEXT")
				buildUp('LOCK')
			}else{
				if(isGameStarted=="预言家"){
					let confirmationHeader = document.getElementById('confirmationHeader');
					confirmationHeader.innerHTML = "查验结果"
					let powerCheck  = document.getElementById('confirmationMsg');
					let badList = ["白狼王","黑狼王","恶魔","狼美人","机械狼","恶灵骑士","机械狼","普通狼人"]
					let goodBad = badList.includes(data) ? "坏人" : "好人"
					powerCheck.innerHTML = id +"号玩家是" + goodBad

					$('#check').modal('show');
				}
			}
		});
		}


}

function closeCheckId(){
	updateGame("NEXT")
	buildUp('LOCK')
}


function power(){
	$('#power').modal('show');
}



async function confirmPower() {
	let ans = await checkRoleMatch()
	console.log(ans)

	if (ans != "NOT READY") {
		let checked = document.getElementsByName("power1");
		let powerName = checked[0] != null ? checked[0].id : false; // kill

		let checked2 = document.getElementsByName("power2");
		let powerName2 = checked2[0] != null ? checked2[0].id : false; //save or not save
		console.log(checked2)

		if (checked[0] != null && checked[0].checked == true) {
			buildUp("POWER") // used to be powername kill
			if(ans=="丘比特"){
				buildUp("LOVE")
			}
		} else {
			select('None')
		}

		if (checked2[0] != null && checked2[0].checked == true) {
			select('MEDICAL')
		}
	}

}
async function checkGameResult(){
		return $.ajax({
			type: "POST",
			url: "http://192.168.1.205:5000/game/checkGameResult",
			dataType: "json",
			cache: false
		}).done(function (data) {
			console.log(data)
		});
}
async function checkIdentities(){
		return $.ajax({
			type: "POST",
			url: "http://192.168.1.205:5000/game/checkIdentities",
			dataType: "json",
			cache: false
		}).done(function (data) {
			console.log(data)
		});
}
function until(conditionFunction) {

  const poll = resolve => {
    if(conditionFunction()) resolve();
    else setTimeout(_ => poll(resolve), 400);
  }

  return new Promise(poll);
}
async function revealCouple(){
	let judgeInfoMsg= document.getElementById("judgeInfoMsg");
	let judgeInfoHeader= document.getElementById("judgeInfoHeader");
	judgeInfoHeader.innerHTML = "情侣信息"
	let msg =  await checkCouple()
	judgeInfoMsg.innerHTML = msg
	$('#judgeInfo').modal('show');

}
async function revealLastNight(id){
	let lastNightResult = await checkGameResult()

	console.log(lastNightResult)
	let identities = await checkIdentities()


	let lastNightMsg = ""

	let poison = parseInt(lastNightResult['女巫'])
	let kill = parseInt(lastNightResult['普通狼人'])
	let medicine = parseInt(lastNightResult['解药'])
	let protect = parseInt(lastNightResult['守卫'])
	let wolfGirl = parseInt(lastNightResult['狼美人'])
	let cupid = lastNightResult['丘比特']!=null ? lastNightResult['丘比特'].split(',') : [0]

	let dieSet  = new Set();
	if(!isNaN(kill)){
		dieSet.add(kill)
	}
	if(!isNaN(poison)){
		dieSet.add(poison)
	}


	if(medicine>0){
		dieSet.delete(medicine)
	}
	if(protect == kill){
		dieSet.delete(protect)
	}
	if(protect == medicine) {
		dieSet.add(protect)
	}
	for(let ele of dieSet){
		if( identities[ele] == "狼美人" ) { // if wolfGirl got poisoned, the one who gets link dies too
			dieSet.add(wolfGirl)
		}
		if (cupid[0]>0 && cupid.indexOf(ele)){ // if one of couple poisoned "check if array contains int"
			cupid.forEach(item => dieSet.add(parseInt(item)))
		}
	}



	if (dieSet.size == 0  ){
		lastNightMsg = "平安夜"

	}else{
		dieSet.forEach(key => {if(key>0) lastNightMsg=lastNightMsg+key+", "})
		lastNightMsg = lastNightMsg.substring(0,lastNightMsg.length-2)+"号玩家出局"
	}
	console.log(dieSet)
	let judgeInfoMsg= document.getElementById("judgeInfoMsg");
	let judgeInfoHeader= document.getElementById("judgeInfoHeader");
	judgeInfoHeader.innerHTML = "昨夜信息"
	if(waitDone==false){
		judgeInfoMsg.innerHTML = lastNightMsg
		if(jQuery.isEmptyObject(lastNightResult) ){
			judgeInfoMsg.innerHTML = "游戏还没开始，无法显示昨夜信息"
		}
	}else{
		judgeInfoMsg.innerHTML = "游戏进行中，无法显示昨夜信息"
	}

	$('#judgeInfo').modal('show');

}
function restartGame(status){
		status = status ? "1":"0"
		let formData = {};
		formData['lockStatus'] = status

		 return $.ajax({
			type: "POST",
			url: "http://192.168.1.205:5000/room/lock",
			data: formData,
			dataType: "json",
			cache: false
		}).done(function (data) {
			nextGame =  data.exists
		});
}

function invert(index){
        let checkbox = document.getElementById("corner"+index)

        let coupleList = checkCoupleNum()
        if(checkbox.classList.contains("check")){
              checkbox.className =" ui corner gray label"
        }else{
        	if(coupleList.length !=2){
        		checkbox.className =" ui corner orange label check"
			}
        }
        coupleList = checkCoupleNum()

        if(coupleList.length==2){
        	let confirmationHeader = document.getElementById('confirmationHeader');
			confirmationHeader.innerHTML = "连接情侣"
        	let powerCheck  = document.getElementById('confirmationMsg');
			powerCheck.innerHTML = "你所连接的情侣是" + coupleList[0] +", " + coupleList[1]

			select(coupleList.toString())
        	$('#check').modal('show');
		}

}

function checkCoupleNum(){
	let coupleList = []
	 for (let i = 1; i <= gloNumSeats; i++) {
                let input = document.getElementById("corner"+i)
                if(input.classList.contains("check") ){
                    coupleList.push(i)
                }
            }
	 return coupleList
}