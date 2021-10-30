
$(document).ready(function(){
	buildUp(false)
	resetCard()
	setInterval(refreshSeat,500);

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

function buildUp(lock){
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

			let labeled_button = document.createElement('dev');
			labeled_button.type = 'button'
			if(!lock) {
				labeled_button.setAttribute('onclick', 'takeSeat(' + i + ')')
			}else{
				labeled_button.setAttribute('onclick', 'select(' + i + ')')
			}
			labeled_button.className = 'ui left labeled button'

			let left_button =  document.createElement('a');
			left_button.className = "ui grey right pointing label"
			left_button.innerHTML = i

			let right_icon = document.createElement('i')
			right_icon.className = "user icon"

			let right_button = document.createElement('div')
			right_button.className ="ui button squareButton"
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

function startGame(){
	let roomSettingList = []
	$.ajax({
	  type: "POST",
	  url: "http://192.168.1.205:5000/seat/refresh",
	  dataType: "json",
	  cache: false
	}).done(function (data) {
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
		  console.log(result)
		  for(let i = 0;i<result.length;i++){

		  }
		  const music = new Audio('static/Howling.mp3');
		  music.play();
		  lockSeat()
		  console.log(data)
	});


}

function power(){
	$('#power').modal('show');
	console.log("hi")
}

function lockSeat(){
	buildUp(true)
}