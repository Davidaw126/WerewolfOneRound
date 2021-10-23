
$(document).ready(function(){
	let createRoomBtn = document.getElementById("createRoom")
	let enterRoomBtn = document.getElementById("enterRoom")
	let msgBtn = document.getElementById("info")

	enterRoomBtn.disabled = true;

    $("#room").on('input',function(e){

        if($("#room").val()==null || $("#room").val()== ""){
            msgBtn.className = "search icon"
            enterRoomBtn.disabled = true;
        }else{
            $.ajax({
						type: "POST",
						url: "http://192.168.1.205:5000/room/check",
						data: $('#registration').serialize(),
						dataType: "html",
						cache: false,
						success: function(msg) {
							let result = JSON.parse(msg)
							if(result.exists){
								msgBtn.className = "green check icon"
								enterRoomBtn.disabled = false;
							}else{
								msgBtn.className = "search icon"
								enterRoomBtn.disabled = true;
							}
						}
					});
        }
    })



})

function submitRoom(createEnter){
	let formData = {
	  room: $("#room").val(),
	  createEnter: createEnter
	};

	$.ajax({
	  type: "POST",
	  url: "http://192.168.1.205:5000/room/add",
	  data: formData,
	  dataType: "json",
	  cache: false
	}).done(function (data) {
	  if(createEnter=='createRoom'){
	  	window.location.href="room"
	  }else if(createEnter=='enterRoom'){
	  	window.location.href="game"
	  }
	});


}

