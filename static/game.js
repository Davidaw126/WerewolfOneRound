var interval;
var waitDone = 'false';
$(document).ready(function(){
	buildUp("initial")
	resetCard()
	gameProgress('default')
	interval = setInterval(refreshSeat,500);

	$('.shape').shape();
	$(".shape").click(function(){
			$('.shape').shape("flip over");
	});


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
	}).done(function (data) {
		  let roomTitleNumber = document.getElementById('roomTitleNumber');
		  roomTitleNumber.innerHTML = "房间号： " + data.roomNumber
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
	$.ajax({
	  type: "POST",
	  url: "http://192.168.1.205:5000/game/shuffle",
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
	$.ajax({
	  type: "POST",
	  url: "http://192.168.1.205:5000/seat/refresh",
	  dataType: "json",
	  cache: false
	}).done(function (data) {
		let numberOfSeats = data.numberOfSeats

		let body = document.getElementById('dynamic_insert');
		body.innerHTML = '';
		for(let i = numberOfSeats ; i > 0; i--){
			let newdiv = document.createElement('div');   //create a div

			newdiv.id = i;                      //add an id
			newdiv.className = 'four wide column'

			let labeled_button = document.createElement('div');
			labeled_button.type = 'button'
			if(gate == "lock") {
				labeled_button.setAttribute('onclick', 'select(' + i + ')')
				labeled_button.className = 'ui left labeled disabled button'
			}else if(gate == "initial"){
				labeled_button.setAttribute('onclick', 'takeSeat(' + i + ')')
				labeled_button.className = 'ui left labeled button'
			}else if(gate = "unlock power"){
				labeled_button.setAttribute('onclick', 'select(' + i + ')')
				labeled_button.className = 'ui left labeled button'
			}



			let left_button =  document.createElement('a');
			left_button.className = "ui grey right pointing label"
			left_button.innerHTML = i

			let right_icon = document.createElement('i')
			right_icon.className = "user icon"

			let right_button = document.createElement('button')
			right_button.className ="ui button squareButton"
			right_button.type ="button"
			if(gate=='unlock power'){
				right_button.className +=" inverted red"
				right_button.type ="button"
			}
			right_button.appendChild(right_icon)

			let right_text = document.createElement('i')
			right_text.id = "name" + i
			right_text.innerHTML = "Empty"
			right_button.appendChild(right_text)

			labeled_button.appendChild(left_button)
			labeled_button.appendChild(right_button)


			newdiv.appendChild(labeled_button)
			body.appendChild(newdiv);
			body.insertBefore(newdiv,body.firstChild)
		}


	});

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
		  let order = ['盗贼','丘比特','野孩子','普通狼人','守卫','预言家','女巫','猎人','狼美人']
		  const sortByObject  = data => data.reduce((obj,item,index) => { return { ...obj, [item]:index } }, {})
		  let orderDict = sortByObject(order) /* {盗贼: 0, 丘比特: 1, 野孩子: 2} */

		  let result = roomSettingList.sort((a, b) => orderDict[a] - orderDict[b])
		  updateGameOrder(result)

		  const music = new Audio('static/Howling.mp3');
		  music.play();
		  lockSeat()
		  setInterval(checkGameRepeat, 3000)


		  for(let i = 0;i<result.length;i++){
		  	 waitDone = result[i];
		  	 let gameResult = {}
			 if(result[i]=="女巫"){
				console.log("asd")
				 gameResult = await new Promise((resolve, reject) => {
								setTimeout(() => resolve(checkGameResult()), 500)
							  });
			 }
			 game(result[i],gameResult)
		  	 await until(_ => result[i] != waitDone); //check if power is used?

		  	 console.log("Done one stage")
		  }

	});


}
async function game(stage, gameResult) {
		let ans = await new Promise((resolve, reject) => {
			setTimeout(() => resolve(checkGame()), 500)
		  });
		gameProgress(ans,gameResult)
	return true
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


function checkGame(){ /* check is role match with currentStage, return  普通狼人/... or Not Ready */

	return $.ajax({
	  type: "POST",
	  url: "http://192.168.1.205:5000/game/checkMatch",
	  dataType: "json",
	  cache: false
	}).done(function (data) {
	});
}

function checkGameRepeat(){ /*check currentStage */
	 $.ajax({
	  type: "POST",
	  url: "http://192.168.1.205:5000/game/checkCurrentStage",
	  dataType: "json",
	  cache: false
	}).done(function (data) {
		waitDone = data
		 console.log(data)
	});
}

function gameProgress(stage, gameResult){
	let body = document.getElementById('powerSelect');
	body.innerHTML = '';



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

	console.log(stage)
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
			let body2 = document.getElementById('powerSelect2');
			let body3 = document.getElementById('powerSelect3');
			let label3 =  document.createElement('label')
			label3.innerHTML = "昨夜被猎杀的是"+ gameResult['普通狼人'] + "号玩家"

			body2.innerHTML = '';
			power2.appendChild(input2)
			power2.appendChild(label2)
			body2.appendChild(power2)
			body3.appendChild(label3)
			break;
		case "猎人":
			label1.innerHTML = "开枪状态为"
			input1.id = "check"
			break;
		case "守卫":
			label1.innerHTML = "是否选择守护"
			input1.id = "check"
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

		let formData = {};
		formData['select'] = id
		$.ajax({
			type: "POST",
			url: "http://192.168.1.205:5000/game/select",
			data: formData,
			dataType: "json",
			cache: false
		}).done(function (data) {
			console.log(data)
			updateGame("NEXT")
			buildUp('lock')
		});

}




function power(){
	$('#power').modal('show');
}

function lockSeat(){
	buildUp("lock")
}

async function confirmPower() {
	let ans = await new Promise((resolve, reject) => {
		setTimeout(() => resolve(checkGame()), 500)
	});
	console.log(ans)

	if (ans != "Not Ready") {
		let checked = document.getElementsByName("power1");
		let powerName = checked[0] != null ? checked[0].id : false; // kill

		let checked2 = document.getElementsByName("power2");
		let powerName2 = checked2[0] != null ? checked2[0].id : false; //save or not save
console.log(checked2)

		if (checked[0] != null && checked[0].checked == true) {
			console.log("sdasd")
			buildUp("unlock power") // used to be powername kill
		} else {
			select('None')
		}

		if (checked2[0] != null && checked2[0].checked == true) {
			select('MEDICAL')
		}
	}

}
function checkGameResult(){
		return $.ajax({
			type: "POST",
			url: "http://192.168.1.205:5000/game/checkGameResult",
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


