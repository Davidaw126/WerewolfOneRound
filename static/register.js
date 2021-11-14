var exists = true;
$(document).ready(function(){
	$("#registration").submit(function(e) {
		e.preventDefault();
	});

	let resetBtn = document.getElementById("register")
	resetBtn.disabled = true;
	$('#msg').hide();
    $("#username").on('input',function(e){
			checkName()
    })


})
function checkName(){
	let resetBtn = document.getElementById("register")
	let msgBtn = document.getElementById("info")

	resetBtn.disabled = true;
	 if($("#username").val()==null || $("#username").val()== ""){
            //$('#msg').hide();
			msgBtn.className = "user circle icon"
        }else{
			let formData={}
			formData["username"] = $("#username").val()
            return $.ajax({
						type: "POST",
						url: "http://172.30.24.194:5000/username/check",
						data: formData,
						dataType: "json",
						cache: false,
						success: function(msg) {
							let result = msg
							exists = result.exists
							if(result.exists){
								//$('#msg').show();
								resetBtn.disabled = true;
								msgBtn.className = "red x icon icon"
							}else{
								//$('#msg').hide();
								resetBtn.disabled = false;
								msgBtn.className = "check icon"
							}

						},
						error: function(jqXHR, textStatus, errorThrown) {
							$('#msg').show();
							$("#msg").html(textStatus + " " + errorThrown);
						}
					});
        }
}
async function submitName() {

	if(exists == false){
		console.log("g")
		let formData = {
			username: $("#username").val()
		};

		return $.ajax({
			type: "POST",
			url: "http://172.30.24.194:5000/username/submit",
			data: formData,
			cache: false,
			dataType: "json",
		}).done(function (data) {
			window.location.href="lobby"
		});
	}



}

