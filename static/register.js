
$(document).ready(function(){
	let resetBtn = document.getElementById("register")
	resetBtn.disabled = true;
	$('#msg').hide();
    $("#username").on('input',function(e){

        if($("#username").val()==null || $("#username").val()== ""){
            $('#msg').hide();
        }else{
            $.ajax({
						type: "POST",
						url: "http://192.168.1.205:5000/username/check",
						data: $('#registration').serialize(),
						dataType: "html",
						cache: false,
						success: function(msg) {
							let result = JSON.parse(msg)
							if(result.exists){
								$('#msg').show();
								resetBtn.disabled = true;
							}else{
								$('#msg').hide();
								resetBtn.disabled = false;
							}
        $.ajax({
				  type: "GET",
				  url: "http://192.168.1.205:5000/lobby",
				}).done(function( o ) {
				   console.log(123)
				});
						},
						error: function(jqXHR, textStatus, errorThrown) {
							$('#msg').show();
							$("#msg").html(textStatus + " " + errorThrown);
						}
					});
        }
    })



})

function submitName(){
		let formData = {
		  username: $("#username").val()
		};

		$.ajax({
		  type: "POST",
		  url: "http://192.168.1.205:5000/username/submit",
		  data: formData,
		  dataType: "json",
		}).done(function (data) {
			window.location.href = "lobby"
		});


}