
$(document).ready(function(){
	refreshSeat(true)
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


function refreshSeat(buildUpGate){
	let formData = {};
	let numberOfSeats = 0
	$.ajax({
	  type: "POST",
	  url: "http://192.168.1.205:5000/seat/refresh",
	  data: formData,
	  dataType: "json",
	  cache: false
	}).done(function (data) {
		numberOfSeats = data.numberOfSeats
		if(buildUpGate){
			buildUp(numberOfSeats)
		}
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
		$('.modal').modal('show');
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

function buildUp(numberOfSeats){
	let body = document.getElementById('dynamic_insert');
	for(let i = numberOfSeats ; i > 0; i--){
		let newdiv = document.createElement('div');   //create a div

    	newdiv.id = i;                      //add an id
		newdiv.className = 'four wide column'

		let labeled_button = document.createElement('dev');
		labeled_button.type = 'button'

		labeled_button.setAttribute('onclick','takeSeat('+i+')')
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

}

